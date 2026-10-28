import path from 'node:path';
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { DIFF_OUTPUT_ARGS, LONG_GIT_TIMEOUT_MS, runGit, runGitWrite, type SnapshotEnv } from './git.js';
import type { StateStore } from './state.js';
import type { DevelopmentChange } from '@warden/shared';
import { importSharedCommit, isSharedCheckout, sharedRepositoryPath, validatedSharedRepository } from './shared-repository.js';

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
export async function applyPatch(
  cwd: string,
  patch: string,
  index: boolean,
  threeWay = false,
  write: (args: string[]) => Promise<unknown> = (args) => runGitWrite(args, { cwd }),
) {
  if (!patch) return;
  const tmp = await mkdtemp(path.join((await import('node:os')).tmpdir(), 'warden-patch-'));
  try {
    const file = path.join(tmp, 'change.patch');
    await writeFile(file, patch, { mode: 0o600 });
    const flags = ['--whitespace=nowarn', ...(index ? ['--index'] : []), ...(threeWay ? ['--3way'] : [])];
    // Preview intentionally leaves index stat data untouched. Once staging is explicitly
    // requested, refresh it so restored-but-identical files satisfy apply --index's check.
    if (index) await write(['update-index', '--refresh']);
    if (!threeWay) await write(['apply', '--check', ...flags, file]);
    await write(['apply', ...flags, file]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Detached worktrees share objects, but trial replay owns its files, index and HEAD. */
export class GitSandbox {
  private constructor(
    readonly path: string,
    private readonly store: StateStore,
    private readonly identity: string[] = [],
  ) {}

  static async create(store: StateStore, source: string, head: string) {
    const root = path.join(path.dirname(store.file), 'operations');
    await mkdir(root, { recursive: true });
    const repository = await importSharedCommit(store.repoRoot, source, head);
    const identity: string[] = [];
    for (const [field, fallback] of [
      ['user.name', 'Warden'],
      ['user.email', 'warden@localhost'],
    ]) {
      const configured = await runGit(['config', '--get', field!], { cwd: source, okCodes: [0, 1] });
      identity.push('-c', `${field}=${configured.stdout.trim() || fallback}`);
    }
    const sandbox = new GitSandbox(await mkdtemp(path.join(root, 'git-')), store, identity);
    try {
      await runGitWrite([...sandbox.options(), 'worktree', 'add', '--quiet', '--detach', '--', sandbox.path, head], { cwd: repository });
      return sandbox;
    } catch (error) {
      await sandbox.dispose();
      throw error;
    }
  }
  static open(store: StateStore, location: string) {
    const root = path.join(path.dirname(store.file), 'operations');
    if (path.dirname(location) !== root || !path.basename(location).startsWith('git-')) throw new Error('Invalid operation directory');
    return new GitSandbox(location, store);
  }

  private options() {
    // This path is beneath the worktree's .git file, so it cannot contain hooks. Never
    // persist these overrides: task commits use the same repository configuration.
    return [
      '-c',
      `core.hooksPath=${path.join(this.path, '.git', 'disabled-hooks')}`,
      '-c',
      'commit.gpgSign=false',
      '-c',
      'tag.gpgSign=false',
      '-c',
      'rebase.updateRefs=false',
      ...this.identity,
    ];
  }

  private async registered(repository: string) {
    const listed = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: repository });
    const wanted = await realpath(this.path).catch(() => path.resolve(this.path));
    for (const field of listed.stdout.split('\0')) {
      if (!field.startsWith('worktree ')) continue;
      const location = field.slice('worktree '.length);
      if ((await realpath(location).catch(() => path.resolve(location))) === wanted) return true;
    }
    return false;
  }

  /** Old journals can still name standalone repositories, but never arbitrary linked worktrees. */
  private async repository() {
    const directory = await lstat(this.path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid operation directory');
    const parent = await realpath(path.dirname(this.path));
    if ((await realpath(this.path)) !== path.join(parent, path.basename(this.path))) throw new Error('Invalid operation directory');
    const git = await lstat(path.join(this.path, '.git'));
    if (git.isDirectory() && !git.isSymbolicLink()) {
      const result = await runGit(['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd: this.path });
      const [top, common] = result.stdout.trim().split('\n');
      if (
        top &&
        common &&
        (await realpath(top)) === (await realpath(this.path)) &&
        (await realpath(path.resolve(this.path, common))) === path.join(await realpath(this.path), '.git')
      )
        return undefined;
      throw new Error('Invalid operation worktree');
    }
    if (!git.isFile() || !(await isSharedCheckout(this.store.repoRoot, this.path))) throw new Error('Invalid operation repository');
    return sharedRepositoryPath(await realpath(this.store.repoRoot));
  }

  async write(args: string[]) {
    await this.repository();
    return runGitWrite([...this.options(), ...args], { cwd: this.path });
  }

  async validate() {
    await this.repository();
  }

  async apply(patch: string, index: boolean, threeWay = false) {
    await this.repository();
    // Applying also writes the index, so it needs the same hook isolation as trial commits.
    await applyPatch(this.path, patch, index, threeWay, (args) => this.write(args));
  }

  async fetch(source: string, head: string) {
    if (!gitOid(head)) throw new Error('Invalid operation commit');
    await this.repository();
    const exists = await runGit(['rev-parse', '--verify', '--quiet', `${head}^{commit}`], { cwd: this.path, okCodes: [0, 1, 128] });
    if (exists.code === 0) return;
    const expected = await runGit(['rev-parse', '--verify', `${head}^{commit}`], { cwd: source });
    if (expected.stdout.trim() !== head) throw new Error('Invalid operation source commit');
    await runGitWrite([...this.options(), 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--', source, head], {
      cwd: this.path,
      timeoutMs: LONG_GIT_TIMEOUT_MS,
    });
  }
  async commit(message = 'Warden temporary composition') {
    await this.write(['commit', '--quiet', '--allow-empty', '-m', message]);
    return oid(this.path, 'HEAD');
  }
  async conflicts() {
    return (await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: this.path })).stdout.split('\0').filter(Boolean);
  }
  async dispose() {
    const directory = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    // A failed worktree add can leave its allocated empty directory. Nothing else at
    // this path is removed until its repository ownership has been verified.
    if (directory && !(await lstat(path.join(this.path, '.git')).catch(() => undefined))) {
      await rmdir(this.path);
      return;
    }
    const shared = directory ? await this.repository() : await validatedSharedRepository(this.store.repoRoot);
    if (shared) {
      if (directory || (await this.registered(shared)))
        await runGitWrite([...this.options(), 'worktree', 'remove', '--force', '--', this.path], { cwd: shared });
    } else if (directory) await rm(this.path, { recursive: true });
  }
}
