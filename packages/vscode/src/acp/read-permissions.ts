import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { EngineOutput } from '@warden/engine';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const pathKeys = new Set(['path', 'file_path', 'filePath']);
const rangeKeys = new Set(['line', 'offset', 'limit', 'start_line', 'end_line']);
const validPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  value.length <= 16_000 &&
  !/[*?[\]{}]/.test(value) &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Only structured file reads qualify. Tool titles and permission labels are not authority. */
export function repositoryReadRequest(request: RequestPermissionRequest, workspace: string) {
  const tool = request.toolCall;
  const choices = request.options.filter((option) => option.kind === 'allow_once');
  if (tool.kind !== 'read' || choices.length !== 1 || !choices[0]!.optionId || tool.content?.some((item) => item.type === 'diff')) return;
  if (request.options.filter((option) => option.optionId === choices[0]!.optionId).length !== 1) return;
  if (!tool.locations?.length || tool.locations.length > 32) return;
  const paths: string[] = [];
  for (const location of tool.locations) {
    if (!validPath(location.path) || !path.isAbsolute(location.path)) return;
    paths.push(path.resolve(location.path));
  }
  if (tool.rawInput != null) {
    if (!object(tool.rawInput)) return;
    for (const [key, value] of Object.entries(tool.rawInput)) {
      if (pathKeys.has(key)) {
        if (!validPath(value) || !paths.includes(path.resolve(workspace, value))) return;
      } else if (!rangeKeys.has(key) || !Number.isSafeInteger(value) || (value as number) < 0) return;
    }
  }
  return { paths: [...new Set(paths)], optionId: choices[0]!.optionId };
}

function relativeSource(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const parts = relative.split(/[\\/]/);
  // These known credential/configuration paths need an explicit choice even inside source roots.
  if (
    parts.some(
      (part) =>
        /^(?:\.git|\.hg|\.svn|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.codex|\.claude|\.config|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.gitconfig)$/i.test(
          part,
        ) ||
        /^(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part) ||
        part.includes(':'),
    )
  )
    return;
  return relative;
}

async function observe(paths: string[], roots: EngineOutput<'repository.readRoots'>) {
  const observations = [];
  for (const file of paths) {
    const root = roots.find((candidate) => relativeSource(candidate.path, file));
    if (!root) return;
    const resolved = await realpath(file);
    if (!relativeSource(root.path, resolved)) return;
    const info = await stat(resolved);
    // A directory approval can include recursive reads of credentials. Hardlinks can alias files outside the root.
    if (!info.isFile() || info.nlink !== 1) return;
    observations.push([root.path, root.identity, resolved, info.dev, info.ino, info.birthtimeMs]);
  }
  return JSON.stringify([roots, observations]);
}

export async function approveRepositoryRead(paths: string[], roots: () => Promise<EngineOutput<'repository.readRoots'>>, validate: () => Promise<void>) {
  const before = await observe(paths, await roots());
  if (!before) return false;
  await validate();
  // Re-read both ownership and resolved targets after asynchronous validation; never cache grants by directory name.
  return before === (await observe(paths, await roots()));
}
