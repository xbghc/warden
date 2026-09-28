import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { RepoInfo, WorktreeInfo } from '@warden/shared';
import { refExists, runGit } from './git.js';
import { HttpError } from './errors.js';

export interface RepoContext {
  /** Root of the worktree the server was started in. */
  root: string;
  /**
   * Root of the main worktree (where .git lives). Started in a clone slot, the checkout it sits
   * beside: the review state and the slots are that one's.
   */
  commonRoot: string;
}

/**
 * The directories warden makes are numbered slots beside the main worktree — `<repo>-1`,
 * `<repo>-2`, … — not one directory per branch. A directory is where the dependencies get
 * installed, and a fresh one for every branch meant installing them for every branch. A slot
 * outlives its branch: released, it stays behind, node_modules and all, for the next branch to be
 * checked out into. A slot is a linked worktree or a clone of its own (see `SlotKind`).
 */
export function slotPath(ctx: RepoContext, slot: number): string {
  return path.join(path.dirname(ctx.commonRoot), `${path.basename(ctx.commonRoot)}-${slot}`);
}

/** The number of the slot at `p`; undefined for a worktree made anywhere else, or named otherwise. */
export function slotOf(ctx: RepoContext, p: string): number | undefined {
  if (path.dirname(p) !== path.dirname(ctx.commonRoot)) return undefined;
  const prefix = `${path.basename(ctx.commonRoot)}-`;
  const name = path.basename(p);
  const n = name.startsWith(prefix) ? name.slice(prefix.length) : '';
  return /^[1-9]\d*$/.test(n) ? Number(n) : undefined;
}

/** A remote as a repository's config has it: the URLs it fetches from and pushes to. */
export interface RemoteConfig {
  urls: string[];
  pushUrls: string[];
}

/** The remotes configured in `cwd`, by name, in the order git lists them. */
export async function readRemotes(cwd: string): Promise<Map<string, RemoteConfig>> {
  // Exit 1 is "no such key": a repository without remotes.
  const r = await runGit(['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { cwd, okCodes: [0, 1] });
  const out = new Map<string, RemoteConfig>();
  for (const line of r.stdout.split('\n')) {
    const m = /^remote\.(.+)\.(url|pushurl) (.*)$/.exec(line);
    if (!m) continue;
    const [, name = '', key, value = ''] = m;
    const remote = out.get(name) ?? { urls: [], pushUrls: [] };
    (key === 'url' ? remote.urls : remote.pushUrls).push(value);
    out.set(name, remote);
  }
  return out;
}

/** Each remote's default branch, as its `<remote>/HEAD` names it: `origin` → `main`. */
export async function remoteHeads(cwd: string): Promise<Map<string, string>> {
  const r = await runGit(['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/remotes'], { cwd });
  const out = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const [ref = '', target = ''] = line.split('\t');
    const m = /^refs\/remotes\/(.+)\/HEAD$/.exec(ref);
    if (m?.[1] && target.startsWith(`refs/remotes/${m[1]}/`)) out.set(m[1], target.slice(`refs/remotes/${m[1]}/`.length));
  }
  return out;
}

/**
 * The branch work in `cwd` goes into: `origin`'s default branch (`origin/main`), else another
 * remote's, else an `origin/main` or `origin/master` that exists. What a clone is compared with when
 * its branch has no upstream, and where a new branch starts in it unless told otherwise — the local
 * `main` of a clone is missing or stale, since nothing but its own checkouts moves it.
 */
export async function remoteDefault(cwd: string): Promise<string | undefined> {
  const heads = await remoteHeads(cwd);
  const origin = heads.get('origin');
  if (origin) return `origin/${origin}`;
  const [other] = heads;
  if (other) return `${other[0]}/${other[1]}`;
  for (const ref of ['origin/main', 'origin/master']) if (await refExists(cwd, `refs/remotes/${ref}`)) return ref;
  return undefined;
}

/** The directory a remote URL names, when it is a path on this machine rather than a server. */
async function localTarget(url: string, cwd: string): Promise<string | undefined> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('file://')) return undefined;
  // scp-like `host:path`; a Windows drive letter is one character before the colon.
  if (/^[^/]{2,}:/.test(url)) return undefined;
  const p = path.resolve(cwd, url.replace(/^file:\/\//, ''));
  return realpath(p).catch(() => undefined);
}

/** The config key a clone slot names its main worktree by, set when warden makes it (see `makeClone`). */
export const CLONE_MARK = 'warden.main';

/**
 * Whether the repository at `dir` is a clone of the one whose main worktree is `mainRoot`. git keeps
 * no record of clones as it does of worktrees, so this is what tells a slot from a repository that
 * merely sits where one would. One warden made names the main worktree in its config, which holds
 * whatever is done to its remotes since — `origin` moved from https to ssh, say. One made by hand is
 * recognised by a remote the main worktree has as well, the server both were cloned from; and for a
 * repository with no server, by a remote that is the main worktree itself.
 */
export async function isCloneOf(mainRoot: string, dir: string, mainRemotes?: Map<string, RemoteConfig>): Promise<boolean> {
  const mark = (await runGit(['config', '--get', CLONE_MARK], { cwd: dir, okCodes: [0, 1] })).stdout.trim();
  if (mark && (await realpath(mark).catch(() => mark)) === mainRoot) return true;
  const [ours, theirs] = await Promise.all([mainRemotes ?? readRemotes(mainRoot), readRemotes(dir)]);
  const known = new Set([...ours.values()].flatMap((r) => r.urls));
  for (const r of theirs.values()) {
    for (const url of r.urls) {
      if (known.has(url) || (await localTarget(url, dir)) === mainRoot) return true;
    }
  }
  return false;
}

/** The main worktree of a repository whose own main worktree is `dir`; undefined for anything else (a linked worktree, a subdirectory). */
async function ownRoot(dir: string): Promise<string | undefined> {
  try {
    const r = await runGit(['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd: dir });
    const [top, common] = r.stdout.trim().split('\n');
    if (!top || !common) return undefined;
    const root = await realpath(top);
    return root === dir && (await realpath(path.resolve(dir, common))) === path.join(root, '.git') ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The main worktree a clone slot at `root` belongs to: `<repo>` beside `<repo>-<n>`, when that is a
 * repository of its own and `root` a clone of it. An agent's `warden feedback` in the clone, or a
 * server started there, then shares that repository's review state, as one in a linked worktree does.
 */
async function mainOfClone(root: string): Promise<string | undefined> {
  const m = /^(.+)-[1-9]\d*$/.exec(path.basename(root));
  if (!m?.[1]) return undefined;
  const main = await ownRoot(path.join(path.dirname(root), m[1]));
  return main && (await isCloneOf(main, root)) ? main : undefined;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function resolveRepo(dir: string): Promise<RepoContext> {
  let top: string;
  try {
    const r = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    top = r.stdout.trim();
  } catch {
    throw new HttpError(400, `${dir} is not inside a git repository`, 'not_a_repo');
  }
  if (!top) throw new HttpError(400, `${dir} is not inside a git worktree (bare repository?)`, 'not_a_repo');
  const root = await safeRealpath(top);
  const common = await runGit(['rev-parse', '--git-common-dir'], { cwd: root });
  const commonDir = await safeRealpath(path.resolve(root, common.stdout.trim()));
  const commonRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : root;
  if (commonRoot === root) {
    const main = await mainOfClone(root);
    if (main) return { root, commonRoot: main };
  }
  return { root, commonRoot };
}

/**
 * The clone slots beside the main worktree: `<repo>-<n>` directories that are repositories of their
 * own (`.git` a directory, where a linked worktree has a file) and clones of this one. git lists
 * linked worktrees for us; for clones the directory itself is all there is to go on. A repository
 * there that is not a clone of this one is left out — it is not ours to write in — and its number
 * stays taken, as any directory with something in it does.
 */
async function listCloneSlots(ctx: RepoContext, listed: Set<string>): Promise<(WorktreeInfo & { prunable: boolean })[]> {
  const parent = path.dirname(ctx.commonRoot);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    // A symlink is not a directory entry here: a slot is a directory beside the main worktree, not a way elsewhere.
    .filter((e) => e.isDirectory() && slotOf(ctx, path.join(parent, e.name)) !== undefined)
    .map((e) => path.join(parent, e.name))
    .filter((p) => !listed.has(p));
  if (!candidates.length) return [];
  const remotes = await readRemotes(ctx.commonRoot);
  const found = await Promise.all(
    candidates.map(async (dir) => {
      const git = await stat(path.join(dir, '.git')).catch(() => undefined);
      if (!git?.isDirectory() || (await ownRoot(dir)) !== dir || !(await isCloneOf(ctx.commonRoot, dir, remotes))) return undefined;
      try {
        const [head, ref] = await Promise.all([
          runGit(['rev-parse', '--verify', 'HEAD'], { cwd: dir }),
          runGit(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd: dir }),
        ]);
        const name = ref.stdout.trim();
        const branch = name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : undefined;
        const trunk = await remoteDefault(dir);
        return {
          path: dir,
          head: head.stdout.trim(),
          branch,
          isMain: false,
          detached: !branch,
          bare: false,
          prunable: false,
          clone: true,
          ...(trunk ? { trunk } : {}),
        };
      } catch {
        // No commit checked out: nothing warden made, and nothing it could release or check out into.
        return undefined;
      }
    }),
  );
  return found.filter((w) => w !== undefined).sort((a, b) => slotOf(ctx, a.path)! - slotOf(ctx, b.path)!);
}

/**
 * Every checkout of the repository: what git lists — the main worktree and the linked ones,
 * including those whose directory is gone (`prunable`) — then the clone slots.
 */
export async function listWorktreesAll(ctx: RepoContext): Promise<(WorktreeInfo & { prunable: boolean })[]> {
  // From the main worktree: in a clone slot, git would list the clone's own worktrees.
  const r = await runGit(['worktree', 'list', '--porcelain'], { cwd: ctx.commonRoot });
  const out: (WorktreeInfo & { prunable: boolean })[] = [];
  let cur: (Partial<WorktreeInfo> & { prunable?: boolean }) | null = null;
  const flush = () => {
    if (cur?.path) {
      out.push({
        path: cur.path,
        head: cur.head ?? '',
        branch: cur.branch,
        isMain: false,
        detached: cur.detached ?? false,
        bare: cur.bare ?? false,
        prunable: cur.prunable ?? false,
      });
    }
    cur = null;
  };
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length) };
    } else if (!cur) {
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  flush();
  // Normalise paths through realpath so they match ctx.root/commonRoot comparisons.
  for (const wt of out) {
    wt.path = await safeRealpath(wt.path);
    wt.isMain = wt.path === ctx.commonRoot;
  }
  return [...out, ...(await listCloneSlots(ctx, new Set(out.map((w) => w.path))))];
}

/**
 * The worktrees something can be reviewed in. One whose directory was deleted behind git's back is
 * still listed by git, marked prunable; nothing can be reviewed there, so it is not offered — the
 * same as after `git worktree remove`. The Worktrees panel lists it, to be dropped.
 */
export async function listWorktrees(ctx: RepoContext): Promise<WorktreeInfo[]> {
  return (await listWorktreesAll(ctx)).filter((w) => !w.prunable).map(({ prunable: _prunable, ...w }) => w);
}

/** Branch checked out at `cwd`. A detached HEAD is identified by its short sha instead. */
export async function currentBranch(cwd: string): Promise<string> {
  const res = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).catch(() => ({ stdout: '' }));
  const name = res.stdout.trim();
  if (name && name !== 'HEAD') return name;
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd }).catch(() => ({ stdout: '' }));
  const sha = head.stdout.trim();
  return sha ? sha.slice(0, 7) : 'HEAD';
}

/** The trunk a feature branch is most likely reviewed against: `main`, else `master`. */
export async function detectDefaultBase(cwd: string): Promise<string | undefined> {
  for (const ref of ['main', 'master']) if (await refExists(cwd, ref)) return ref;
  return undefined;
}

export async function getRepoInfo(ctx: RepoContext, defaultTarget: string): Promise<RepoInfo> {
  const [branch, headRes, worktrees, defaultBase] = await Promise.all([
    currentBranch(ctx.root),
    runGit(['rev-parse', 'HEAD'], { cwd: ctx.root }).catch(() => ({ stdout: '' })),
    listWorktrees(ctx),
    detectDefaultBase(ctx.root),
  ]);
  return {
    root: ctx.root,
    commonRoot: ctx.commonRoot,
    branch,
    head: headRes.stdout.trim(),
    worktrees,
    defaultTarget,
    ...(defaultBase ? { defaultBase } : {}),
  };
}
