import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DIFF_OUTPUT_ARGS, runGit, runGitWrite, type SnapshotEnv } from './git.js';
import type { StateStore } from './state.js';
import type { DevelopmentChange } from '@warden/shared';

export const gitOid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
export const gitMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export async function oid(cwd: string, ref: string) {
  return (await runGit(['rev-parse', '--verify', ref], { cwd })).stdout.trim();
}
/** A manual rebase/merge may already have incorporated the new primary baseline. */
export async function deliveryBase(change: DevelopmentChange, head: string, target: string) {
  const contains = await runGit(['merge-base', '--is-ancestor', target, head], { cwd: change.worktree, okCodes: [0, 1, 128] });
  return contains.code === 0 ? target : (change.sourceBase ?? change.base);
}
export async function patchBetween(cwd: string, from: string, to: string, snapshot?: SnapshotEnv) {
  const args = ['diff', ...DIFF_OUTPUT_ARGS, '--binary', '--full-index', '--no-renames', from, to, '--'];
  return (await runGit(args, { cwd, snapshot })).stdout;
}

/** Server-generated patches only. No shell, no partial/reject application, no automatic stash. */
export async function applyPatch(cwd: string, patch: string, index: boolean, threeWay = false) {
  if (!patch) return;
  const tmp = await mkdtemp(path.join((await import('node:os')).tmpdir(), 'warden-patch-'));
  try {
    const file = path.join(tmp, 'change.patch');
    await writeFile(file, patch, { mode: 0o600 });
    const flags = ['--whitespace=nowarn', ...(index ? ['--index'] : []), ...(threeWay ? ['--3way'] : [])];
    // Preview intentionally leaves index stat data untouched. Once staging is explicitly
    // requested, refresh it so restored-but-identical files satisfy apply --index's check.
    if (index) await runGitWrite(['update-index', '--refresh'], { cwd });
    if (!threeWay) await runGitWrite(['apply', '--check', ...flags, file], { cwd });
    await runGitWrite(['apply', ...flags, file], { cwd });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Independent repository: trial replay cannot touch any agent's index, files or refs. */
export class GitSandbox {
  private constructor(readonly path: string) {}
  static async create(store: StateStore, source: string, head: string) {
    const root = path.join(path.dirname(store.file), 'operations');
    await mkdir(root, { recursive: true });
    const sandbox = new GitSandbox(await mkdtemp(path.join(root, 'git-')));
    try {
      await runGitWrite(['init', '--quiet', '--template=', ...(head.length === 64 ? ['--object-format=sha256'] : []), sandbox.path], { cwd: root });
      await sandbox.write(['config', 'core.hooksPath', path.join(sandbox.path, '.git', 'disabled-hooks')]);
      for (const [field, fallback] of [
        ['user.name', 'Warden'],
        ['user.email', 'warden@localhost'],
      ]) {
        const configured = await runGit(['config', '--get', field!], { cwd: source, okCodes: [0, 1] });
        await sandbox.write(['config', field!, configured.stdout.trim() || fallback!]);
      }
      await sandbox.fetch(source, head);
      await sandbox.write(['checkout', '--quiet', '--detach', head]);
      return sandbox;
    } catch (error) {
      await sandbox.dispose();
      throw error;
    }
  }
  static open(store: StateStore, location: string) {
    const root = path.join(path.dirname(store.file), 'operations');
    if (path.dirname(location) !== root || !path.basename(location).startsWith('git-')) throw new Error('Invalid operation directory');
    return new GitSandbox(location);
  }
  write(args: string[]) {
    return runGitWrite(['-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'rebase.updateRefs=false', ...args], { cwd: this.path });
  }
  fetch(source: string, head: string) {
    return this.write(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', source, head]);
  }
  async commit(message = 'Warden temporary composition') {
    await this.write(['commit', '--quiet', '--allow-empty', '-m', message]);
    return oid(this.path, 'HEAD');
  }
  async conflicts() {
    return (await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: this.path })).stdout.split('\0').filter(Boolean);
  }
  dispose() {
    return rm(this.path, { recursive: true, force: true });
  }
}
