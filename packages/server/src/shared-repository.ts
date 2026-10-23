import path from 'node:path';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { HttpError } from './errors.js';
import { LONG_GIT_TIMEOUT_MS, runGit, runGitWrite } from './git.js';
import { StateStore } from './state.js';

const PRIMARY_MARK = 'warden.sharedPrimary';
const VERSION_MARK = 'warden.sharedVersion';
const initializations = new Map<string, Promise<string>>();
const immutableCommit = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Task branches and internal worktrees share this repository, never the primary object store. */
export function sharedRepositoryPath(primary: string): string {
  return path.join(path.dirname(primary), `${path.basename(primary)}-warden`, 'repo.git');
}

function invalid(message: string): never {
  throw new HttpError(409, message, 'shared_repository_invalid');
}

async function directory(location: string): Promise<boolean> {
  const info = await lstat(location).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(location)) !== location) invalid(`Warden 公共仓库路径不是独立目录：${location}`);
  return true;
}

async function validate(owner: string): Promise<string | undefined> {
  const repository = sharedRepositoryPath(owner);
  if (!(await directory(path.dirname(repository))) || !(await directory(repository))) return undefined;
  try {
    const [location, ownership] = await Promise.all([
      runGit(['rev-parse', '--is-bare-repository', '--absolute-git-dir'], { cwd: repository }),
      runGit(['config', '--get-regexp', '^warden\\.(sharedprimary|sharedversion)$'], { cwd: repository, okCodes: [0, 1] }),
    ]);
    const [kind, common] = location.stdout.trim().split('\n');
    const values = new Map(
      ownership.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf(' ');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    if (
      kind !== 'true' ||
      !common ||
      (await realpath(common)) !== repository ||
      values.get(PRIMARY_MARK.toLowerCase()) !== owner ||
      values.get(VERSION_MARK.toLowerCase()) !== '1'
    )
      invalid(`Warden 公共仓库归属不匹配：${repository}`);
    return repository;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'shared_repository_invalid') throw error;
    invalid(`无法验证 Warden 公共仓库：${repository}`);
  }
}

/** Read-only ownership check. Existing foreign directories are never adopted or overwritten. */
export async function validatedSharedRepository(primary: string): Promise<string | undefined> {
  const owner = await realpath(primary);
  const pending = initializations.get(owner);
  if (pending) await pending;
  return validate(owner);
}

async function initialize(primary: string): Promise<string> {
  const existing = await validate(primary);
  if (existing) return existing;
  const repository = sharedRepositoryPath(primary);
  const root = path.dirname(repository);
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await directory(root);
  // Claim the final path before initializing. Another process may retry once this initialization
  // finishes; it must never overwrite an unrelated directory or an unfinished repository.
  try {
    await mkdir(repository, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await validate(primary)) ?? invalid('Warden 公共仓库正在初始化，请重试');
  }
  try {
    const format = (await runGit(['rev-parse', '--show-object-format'], { cwd: primary })).stdout.trim();
    if (format !== 'sha1' && format !== 'sha256') invalid('无法识别主仓库的对象格式');
    await runGitWrite(['init', '--quiet', '--bare', '--template=', `--object-format=${format}`, repository], { cwd: root });
    for (const field of ['user.name', 'user.email']) {
      const value = await runGit(['config', '--get', field], { cwd: primary, okCodes: [0, 1] });
      if (value.code === 0) await runGitWrite(['config', field, value.stdout.trim()], { cwd: repository });
    }
    await runGitWrite(['config', PRIMARY_MARK, primary], { cwd: repository });
    await runGitWrite(['config', VERSION_MARK, '1'], { cwd: repository });
    return repository;
  } catch (error) {
    await rm(repository, { recursive: true, force: true });
    throw error;
  }
}

async function initializeLocked(primary: string): Promise<string> {
  const root = path.dirname(sharedRepositoryPath(primary));
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await directory(root);
  // Reuse the existing cross-process lock protocol, including its heartbeat and dead-owner
  // recovery. No state file is written here. Read-only synchronization trials also create
  // internal worktrees, so initialization cannot rely on the caller's workflow mutation lock.
  return new StateStore(path.join(root, 'initialization'), primary).withRepositoryLock(() => initialize(primary));
}

/** Lazy creation is serialized across servers as well as concurrent trials in this server. */
export async function ensureSharedRepository(primary: string): Promise<string> {
  const owner = await realpath(primary);
  let pending = initializations.get(owner);
  if (!pending) {
    pending = initializeLocked(owner);
    initializations.set(owner, pending);
  }
  try {
    return await pending;
  } finally {
    if (initializations.get(owner) === pending) initializations.delete(owner);
  }
}

/** Import one immutable local commit; shared task commits already exist and require no fetch. */
export async function importSharedCommit(primary: string, source: string, sha: string): Promise<string> {
  if (!immutableCommit.test(sha)) throw new HttpError(400, '公共仓库只接受完整的提交版本', 'invalid_commit');
  const from = await realpath(source);
  const sourceCommit = await runGit(['rev-parse', '--verify', `${sha}^{commit}`], { cwd: from });
  if (sourceCommit.stdout.trim() !== sha) throw new HttpError(409, '源提交版本不匹配', 'invalid_commit');
  const repository = await ensureSharedRepository(primary);
  const present = await runGit(['rev-parse', '--verify', `${sha}^{commit}`], { cwd: repository, okCodes: [0, 128] });
  if (present.code !== 0)
    await runGitWrite(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--', from, sha], {
      cwd: repository,
      timeoutMs: LONG_GIT_TIMEOUT_MS,
    });
  return repository;
}

/** Git accepts a copied .git pointer while reporting the new working directory as its top level.
 * Validate the reverse registration as well, before a write can reach another checkout's index.
 */
export async function isSharedCheckout(primary: string, checkout: string): Promise<boolean> {
  try {
    const repository = await validatedSharedRepository(primary);
    if (!repository) return false;
    const root = await realpath(checkout);
    const gitfile = path.join(root, '.git');
    const gitfileInfo = await lstat(gitfile);
    if (!gitfileInfo.isFile() || gitfileInfo.isSymbolicLink()) return false;
    const locations = (await runGit(['rev-parse', '--show-toplevel', '--git-common-dir', '--absolute-git-dir'], { cwd: root })).stdout.trim().split('\n');
    if (locations.length !== 3 || (await realpath(locations[0]!)) !== root) return false;
    if ((await realpath(path.resolve(root, locations[1]!))) !== repository) return false;
    const privateDirectory = path.resolve(root, locations[2]!);
    const registrations = path.join(repository, 'worktrees');
    if (path.dirname(privateDirectory) !== registrations || !(await directory(registrations)) || !(await directory(privateDirectory))) return false;
    const backlink = path.join(privateDirectory, 'gitdir');
    const backlinkInfo = await lstat(backlink);
    if (!backlinkInfo.isFile() || backlinkInfo.isSymbolicLink()) return false;
    const target = path.resolve(privateDirectory, (await readFile(backlink, 'utf8')).trim());
    return target === gitfile && (await realpath(target)) === gitfile;
  } catch {
    return false;
  }
}

/** Resolve a managed worktree to its primary without trusting an arbitrary ownership marker. */
export async function sharedRepositoryOwner(cwd: string): Promise<string | undefined> {
  const common = (await runGit(['rev-parse', '--git-common-dir'], { cwd })).stdout.trim();
  const repository = await realpath(path.resolve(cwd, common));
  const marker = await runGit(['config', '--get', PRIMARY_MARK], { cwd: repository, okCodes: [0, 1] });
  if (marker.code !== 0 || !marker.stdout.trim()) return undefined;
  const primary = await realpath(marker.stdout.trim()).catch(() => undefined);
  if (!primary || sharedRepositoryPath(primary) !== repository) invalid('Warden 公共仓库归属路径不匹配');
  if ((await validatedSharedRepository(primary)) !== repository) invalid('Warden 公共仓库归属不匹配');
  if (!(await isSharedCheckout(primary, cwd))) invalid('Warden 工作区的 Git 注册路径不匹配');
  return primary;
}
