import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { parseFileReference } from '@warden/shared';

/** Agent links can reveal saved files in this task only, never invoke URI handlers. */
export async function readWorkspaceReference(workspace: string, reference: string) {
  const parsed = parseFileReference(reference);
  if (!parsed) throw new Error('Invalid workspace file reference.');
  const root = await realpath(workspace);
  const candidate = path.resolve(workspace, parsed.path);
  const within = (file: string, base = root) => {
    const relative = path.relative(base, file);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!within(candidate, path.resolve(workspace))) throw new Error('File references must stay inside this task workspace.');
  const resolved = await realpath(candidate);
  if (!within(resolved)) throw new Error('File references must stay inside this task workspace.');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 2_000_000) throw new Error('Open a text file of at most 2 MB from this task workspace.');
  const bytes = await readFile(resolved);
  if (bytes.includes(0)) throw new Error('This reference is a binary file. Use the task diff to review it.');
  return { ...parsed, path: path.relative(root, resolved).split(path.sep).join('/'), content: bytes.toString('utf8') };
}
