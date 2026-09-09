import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  ChangeEvent,
  Comment,
  CommitsResponse,
  CreateCommentRequest,
  CreateIssueRequest,
  CreateTodoRequest,
  ExportRequest,
  ExportResponse,
  ForkPointResponse,
  FileDiff,
  FileEntry,
  FilesResponse,
  FullFileResponse,
  Issue,
  MoveRequest,
  NvimInstancesResponse,
  NvimOpenRequest,
  Prefs,
  ReanchorRequest,
  ReanchorResponse,
  RepoInfo,
  ReviewState,
  StageRequest,
  StageResponse,
  Todo,
  TodosResponse,
  UpdateCommentRequest,
  UpdateIssueRequest,
  UpdateTodoRequest,
  WorktreeInfo,
} from '@warden/shared';
import { commentScopeKey, insertAfter, isLocalTarget, isValidRef, localViewKeys, moveBefore, stageModeFor, tryParseTargetKey } from '@warden/shared';
import { badRequest, HttpError, notFound } from './errors.js';
import { COMMIT_FORMAT, parseCommitLog } from './commits.js';
import { applyToIndex, mergeBase, refExists, revParse, runGit } from './git.js';
import { currentBranch, getRepoInfo, listWorktrees, type RepoContext } from './repo.js';
import { getFileDiff, getFullFile, listTargetDiffs, resolveTargetContext, toSummary, type TargetContext } from './targets.js';
import { buildAnchor, reanchorComment } from './anchor.js';
import { buildStagePatch } from './patch.js';
import { ensureTarget, StateStore } from './state.js';
import { formatCommentsExport, formatIssueExport } from './export.js';
import { NvimService } from './nvim.js';
import { RepoWatcher } from './watcher.js';
import { serveStaticFile } from './static.js';


export interface AppOptions {
  repo: RepoContext;
  store: StateStore;
  nvim?: NvimService;
  /** Directory of the built web app; when omitted only /api is served. */
  webDir?: string;
  /** Poll interval of the repository watchers; tests use a short one. */
  watchIntervalMs?: number;
  /** Echoed by GET /api/ping, so a caller can tell this process apart from whatever else answers. */
  instanceToken?: string;
}

const SSE_HEARTBEAT_MS = 15_000;

interface ListingCache {
  at: number;
  files: FileDiff[];
}

const LISTING_HINT_TTL_MS = 5 * 60_000;

export function createApp(opts: AppOptions): Hono {
  const { repo, store } = opts;
  const nvim = opts.nvim ?? new NvimService();
  const app = new Hono();

  /** Last listing per target: only used to recover rename/untracked hints for single-file requests. */
  const listings = new Map<string, ListingCache>();
  /** Files whose viewed flag was dropped because their diff changed (in-memory notice). */
  const changedNotices = new Map<string, Set<string>>();
  /** One watcher per worktree root, started lazily and stopped when the last client disconnects. */
  const watchers = new Map<string, RepoWatcher>();
  const watcherFor = (root: string): RepoWatcher => {
    let w = watchers.get(root);
    if (!w) {
      w = new RepoWatcher(root, opts.watchIntervalMs);
      watchers.set(root, w);
    }
    return w;
  };

  let worktreeCache: { at: number; list: WorktreeInfo[] } | null = null;
  const worktrees = async (force = false): Promise<WorktreeInfo[]> => {
    if (!force && worktreeCache && Date.now() - worktreeCache.at < 10_000) return worktreeCache.list;
    const list = await listWorktrees(repo);
    worktreeCache = { at: Date.now(), list };
    return list;
  };

  const targetCtx = async (key: string): Promise<TargetContext> => {
    let list = await worktrees();
    try {
      return resolveTargetContext(repo, list, key);
    } catch (e) {
      if (e instanceof HttpError && e.code === 'unknown_worktree') {
        list = await worktrees(true);
        return resolveTargetContext(repo, list, key);
      }
      throw e;
    }
  };

  const fileDiffWithHints = async (ctx: TargetContext, filePath: string, explicit?: { oldPath?: string; untracked?: boolean }) => {
    const cached = listings.get(ctx.key);
    const hint = cached && Date.now() - cached.at < LISTING_HINT_TTL_MS ? cached.files.find((f) => f.path === filePath) : undefined;
    return getFileDiff(ctx, filePath, {
      oldPath: explicit?.oldPath ?? hint?.oldPath,
      untracked: explicit?.untracked ?? hint?.untracked,
    });
  };

  const findComment = (state: ReviewState, id: string): { comment: Comment; targetKey: string; index: number } | undefined => {
    for (const [targetKey, t] of Object.entries(state.targets)) {
      const index = t.comments.findIndex((c) => c.id === id);
      if (index >= 0) return { comment: t.comments[index]!, targetKey, index };
    }
    return undefined;
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : String(err), code: 'internal' }, 500);
  });

  const api = new Hono();

  // Cheap identity check: no git, no state file. See wsl.ts for who asks and why.
  api.get('/ping', (c) => c.text(opts.instanceToken ?? ''));

  api.get('/repo', async (c) => {
    const state = await store.load();
    const info: RepoInfo = await getRepoInfo(repo, 'working');
    worktreeCache = { at: Date.now(), list: info.worktrees };
    // The remembered target is handed back only while it can still be opened. One inside a
    // worktree that has since been removed would strand the page on an error: everything it
    // could click next carries that worktree along, and the next load would land there again.
    const last = state.prefs.lastTarget;
    const target = last ? tryParseTargetKey(last) : undefined;
    const usable = !!target && (!target.worktree || info.worktrees.some((w) => w.path === target.worktree));
    if (last && usable) info.defaultTarget = last;
    else if (last) await store.update((s) => void (s.prefs.lastTarget = 'working'));
    return c.json(info);
  });

  api.get('/state', async (c) => c.json(await store.load()));

  api.patch('/prefs', async (c) => {
    const body = (await c.req.json()) as Partial<Prefs>;
    const prefs = await store.update((s) => {
      if (body.viewMode === 'unified' || body.viewMode === 'split') s.prefs.viewMode = body.viewMode;
      if (typeof body.lastTarget === 'string') s.prefs.lastTarget = body.lastTarget;
      if (typeof body.autoRefresh === 'boolean') s.prefs.autoRefresh = body.autoRefresh;
      if (body.nvimSocketByRoot && typeof body.nvimSocketByRoot === 'object') {
        s.prefs.nvimSocketByRoot = { ...s.prefs.nvimSocketByRoot, ...body.nvimSocketByRoot };
      }
      return s.prefs;
    });
    return c.json(prefs);
  });

  // ---- targets -----------------------------------------------------------

  api.get('/targets/:key/files', async (c) => {
    const key = c.req.param('key');
    const ctx = await targetCtx(key);
    const diffs = await listTargetDiffs(ctx);
    listings.set(key, { at: Date.now(), files: diffs });
    const notices = changedNotices.get(key) ?? new Set<string>();
    changedNotices.set(key, notices);

    const stale: string[] = [];
    const state = await store.load();
    const t = state.targets[key];
    const viewed = t?.viewed ?? {};
    for (const [p, h] of Object.entries(viewed)) {
      const f = diffs.find((d) => d.path === p);
      if (!f || f.contentHash !== h) stale.push(p);
    }
    if (stale.length) {
      await store.update((s) => {
        const ts = s.targets[key];
        if (!ts) return;
        for (const p of stale) {
          if (ts.viewed[p] === viewed[p]) {
            delete ts.viewed[p];
            if (diffs.some((d) => d.path === p)) notices.add(p);
          }
        }
      });
    }
    const files: FileEntry[] = diffs.map((d) => ({
      ...toSummary(d),
      viewed: !stale.includes(d.path) && viewed[d.path] === d.contentHash,
      changed: notices.has(d.path),
    }));
    const scope = state.targets[commentScopeKey(key)];
    const res: FilesResponse = { targetKey: key, root: ctx.cwd, files, comments: scope?.comments ?? [] };
    return c.json(res);
  });

  api.get('/targets/:key/file', async (c) => {
    const key = c.req.param('key');
    const filePath = c.req.query('path');
    if (!filePath) throw badRequest('missing path');
    const ctx = await targetCtx(key);
    const oldPath = c.req.query('old') || undefined;
    const untracked = c.req.query('untracked') === '1' ? true : undefined;
    const diff = await fileDiffWithHints(ctx, filePath, { oldPath, untracked });
    if (!diff) throw notFound(`no diff for ${filePath} in ${key}`, 'no_diff');
    return c.json(diff);
  });

  api.get('/targets/:key/file/full', async (c) => {
    const key = c.req.param('key');
    const filePath = c.req.query('path');
    if (!filePath) throw badRequest('missing path');
    const side = c.req.query('side') === 'old' ? 'old' : 'new';
    const ctx = await targetCtx(key);
    const content = await getFullFile(ctx, filePath, side);
    const res: FullFileResponse = { path: filePath, side, content };
    return c.json(res);
  });

  api.put('/targets/:key/viewed', async (c) => {
    const key = c.req.param('key');
    await targetCtx(key);
    const body = (await c.req.json()) as { path?: string; viewed?: boolean; contentHash?: string };
    if (!body.path) throw badRequest('missing path');
    const viewed = await store.update((s) => {
      const t = ensureTarget(s, key);
      if (body.viewed && body.contentHash) t.viewed[body.path!] = body.contentHash;
      else delete t.viewed[body.path!];
      return t.viewed;
    });
    changedNotices.get(key)?.delete(body.path);
    return c.json({ viewed });
  });

  // ---- staging -----------------------------------------------------------

  // The only route that writes to the repository, and only to the index: the lines picked in the
  // Unstaged view go in, the ones picked in the Staged view come back out. Staging is how a
  // reviewer says "these lines are done", so it belongs next to reading them.
  api.post('/targets/:key/stage', async (c) => {
    const key = c.req.param('key');
    const ctx = await targetCtx(key);
    const mode = stageModeFor(ctx.target);
    if (!mode) throw badRequest('only the working (stage) and staged (unstage) views can be staged from', 'not_stageable');
    const body = (await c.req.json()) as StageRequest;
    if (!body.path || typeof body.path !== 'string') throw badRequest('missing path');
    if (!body.contentHash || typeof body.contentHash !== 'string') throw badRequest('contentHash is required');
    if (body.hunks !== undefined && !Array.isArray(body.hunks)) throw badRequest('hunks must be an array', 'bad_selection');
    const diff = await fileDiffWithHints(ctx, body.path);
    if (!diff) throw badRequest(`file ${body.path} is not part of ${key}`, 'no_diff');
    // The selection is a set of indices into a diff the client saw; against any other diff they
    // would name the wrong lines. The agent may well have edited the file since.
    if (diff.contentHash !== body.contentHash) throw new HttpError(409, 'the diff changed since it was loaded; refresh and pick the lines again', 'diff_changed');
    const { patch, lines } = buildStagePatch(diff, mode, body.hunks);
    await applyToIndex(ctx.cwd, patch, { reverse: mode === 'unstage' });
    // Tell every page on this worktree straight away rather than at the next poll.
    void watchers.get(ctx.cwd)?.poll();
    const res: StageResponse = { ok: true, lines };
    return c.json(res);
  });

  // ---- comments ----------------------------------------------------------

  api.get('/targets/:key/comments', async (c) => {
    const key = c.req.param('key');
    const state = await store.load();
    return c.json({ comments: state.targets[commentScopeKey(key)]?.comments ?? [] });
  });

  api.post('/targets/:key/comments', async (c) => {
    const key = c.req.param('key');
    const ctx = await targetCtx(key);
    const body = (await c.req.json()) as CreateCommentRequest;
    if (!body.filePath || typeof body.body !== 'string' || !body.body.trim()) throw badRequest('filePath and body are required');
    if (body.side !== 'old' && body.side !== 'new') throw badRequest('side must be old|new');
    const start = Number(body.startLine);
    const end = Number(body.endLine ?? body.startLine);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) throw badRequest('invalid line range');
    const diff = await fileDiffWithHints(ctx, body.filePath);
    if (!diff) throw badRequest(`file ${body.filePath} is not part of ${key}`, 'no_diff');
    const anchored = buildAnchor(diff, body.side, start, end);
    if (!anchored) throw badRequest('selection is not fully visible in the diff on that side (must be inside one hunk)', 'bad_selection');
    const now = new Date().toISOString();
    const comment: Comment = {
      id: randomUUID(),
      targetKey: key,
      filePath: body.filePath,
      side: body.side,
      startLine: anchored.startLine,
      endLine: anchored.endLine,
      codeSnippet: anchored.snippet,
      body: body.body,
      status: 'active',
      anchor: anchored.anchor,
      createdAt: now,
      updatedAt: now,
    };
    await store.update((s) => {
      ensureTarget(s, commentScopeKey(key)).comments.push(comment);
    });
    return c.json(comment, 201);
  });

  api.patch('/targets/:key/comments/:id', async (c) => {
    const key = c.req.param('key');
    const id = c.req.param('id');
    const ctx = await targetCtx(key);
    const body = (await c.req.json()) as UpdateCommentRequest;
    const scope = commentScopeKey(key);
    const state = await store.load();
    const existing = state.targets[scope]?.comments.find((x) => x.id === id);
    if (!existing) throw notFound('comment not found');

    let patch: Partial<Comment> = {};
    if (typeof body.body === 'string') {
      if (!body.body.trim()) throw badRequest('body must not be empty');
      patch.body = body.body;
    }
    if (body.startLine !== undefined || body.side !== undefined) {
      const side = body.side ?? existing.side;
      const start = Number(body.startLine ?? existing.startLine);
      const end = Number(body.endLine ?? body.startLine ?? existing.endLine);
      if (side !== 'old' && side !== 'new') throw badRequest('side must be old|new');
      const diff = await fileDiffWithHints(ctx, existing.filePath);
      if (!diff) throw badRequest(`file ${existing.filePath} is not part of ${key}`, 'no_diff');
      const anchored = buildAnchor(diff, side, start, end);
      if (!anchored) throw badRequest('selection is not fully visible in the diff on that side', 'bad_selection');
      patch = {
        ...patch,
        side,
        startLine: anchored.startLine,
        endLine: anchored.endLine,
        codeSnippet: anchored.snippet,
        anchor: anchored.anchor,
        status: existing.exportedAt ? 'exported' : 'active',
        // Re-attaching in a view moves the comment to it.
        targetKey: key,
      };
    }
    const updated = await store.update((s) => {
      const t = ensureTarget(s, scope);
      const idx = t.comments.findIndex((x) => x.id === id);
      if (idx < 0) throw notFound('comment not found');
      const next: Comment = { ...t.comments[idx]!, ...patch, updatedAt: new Date().toISOString() };
      t.comments[idx] = next;
      return next;
    });
    return c.json(updated);
  });

  api.delete('/targets/:key/comments/:id', async (c) => {
    const key = c.req.param('key');
    const id = c.req.param('id');
    const removed = await store.update((s) => {
      const t = s.targets[commentScopeKey(key)];
      if (!t) return false;
      const before = t.comments.length;
      t.comments = t.comments.filter((x) => x.id !== id);
      for (const issue of s.issues) issue.commentIds = issue.commentIds.filter((x) => x !== id);
      return t.comments.length !== before;
    });
    if (!removed) throw notFound('comment not found');
    return c.json({ ok: true });
  });

  api.post('/targets/:key/comments/reanchor', async (c) => {
    const key = c.req.param('key');
    const ctx = await targetCtx(key);
    const scope = commentScopeKey(key);
    const local = isLocalTarget(ctx.target);
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as ReanchorRequest;
    const provided = new Map<string, FileDiff>();
    for (const f of body.files ?? []) if (f && typeof f.path === 'string' && Array.isArray(f.hunks)) provided.set(f.path, f);

    // Staging a hunk moves it from `working` to `staged` without changing the code, so a comment
    // that vanished from one view has most likely just reappeared in another. Every local view of
    // this worktree is therefore a candidate; commit/range targets only ever look at themselves.
    const views = local ? localViewKeys(key) : [key];
    const contexts = new Map<string, TargetContext>([[key, ctx]]);
    /** view key -> file path -> diff, computed at most once per pass. */
    const diffs = new Map<string, Map<string, Promise<FileDiff | undefined>>>();
    const diffFor = (view: string, filePath: string): Promise<FileDiff | undefined> => {
      let byPath = diffs.get(view);
      if (!byPath) {
        byPath = new Map();
        diffs.set(view, byPath);
      }
      let pending = byPath.get(filePath);
      if (!pending) {
        pending = (async () => {
          // Diffs in the request body describe the view the client is looking at, nothing else.
          if (view === key && provided.has(filePath)) return provided.get(filePath);
          try {
            let viewCtx = contexts.get(view);
            if (!viewCtx) {
              viewCtx = await targetCtx(view);
              contexts.set(view, viewCtx);
            }
            return await fileDiffWithHints(viewCtx, filePath);
          } catch {
            return undefined;
          }
        })();
        byPath.set(filePath, pending);
      }
      return pending;
    };

    const state = await store.load();
    const comments = state.targets[scope]?.comments ?? [];
    const prevHead = state.targets[scope]?.head;
    const head = (await revParse(ctx.cwd, 'HEAD')) ?? '';
    // A moved HEAD means the round under review was committed: comments with nowhere left to sit
    // are finished work, not orphans. Never on the first pass, when there is no HEAD to compare to.
    const committed = local && prevHead !== undefined && prevHead !== head;

    const now = new Date().toISOString();
    /** comment id -> the view it was located in, and the fields that follow from that location. */
    const located = new Map<string, Partial<Comment>>();
    await Promise.all(
      comments.map(async (cm) => {
        const ordered = views.includes(cm.targetKey) ? [cm.targetKey, ...views.filter((v) => v !== cm.targetKey)] : views;
        for (const view of ordered) {
          const diff = await diffFor(view, cm.filePath);
          if (!diff) continue;
          const next = reanchorComment(cm, diff, now);
          if (next.status === 'orphaned') continue;
          located.set(cm.id, {
            side: next.side,
            startLine: next.startLine,
            endLine: next.endLine,
            codeSnippet: next.codeSnippet,
            anchor: next.anchor,
            status: next.status,
            targetKey: view,
          });
          return;
        }
      }),
    );

    const result = await store.update((s) => {
      const t = ensureTarget(s, scope);
      const dropped: string[] = [];
      // The patch is applied to the freshest copy so a body edited while the diffs were computed
      // is not overwritten by the snapshot this pass started from.
      t.comments = t.comments.flatMap((cm): Comment[] => {
        const patch = located.get(cm.id);
        if (!patch) {
          // Created after the snapshot: not part of this pass, leave untouched.
          if (!comments.some((x) => x.id === cm.id)) return [cm];
          if (committed) {
            dropped.push(cm.id);
            return [];
          }
          return [cm.status === 'orphaned' ? cm : { ...cm, status: 'orphaned', updatedAt: now }];
        }
        const next: Comment = { ...cm, ...patch };
        const unchanged =
          cm.targetKey === next.targetKey &&
          cm.status === next.status &&
          cm.startLine === next.startLine &&
          cm.endLine === next.endLine &&
          cm.anchor.hunkHash === next.anchor.hunkHash;
        return [unchanged ? cm : { ...next, updatedAt: now }];
      });
      for (const id of dropped) {
        for (const issue of s.issues) issue.commentIds = issue.commentIds.filter((x) => x !== id);
      }
      t.head = head;
      return t.comments;
    });
    const res: ReanchorResponse = { comments: result };
    return c.json(res);
  });

  api.post('/comments/export', async (c) => {
    const body = (await c.req.json()) as ExportRequest;
    if (!Array.isArray(body.commentIds)) throw badRequest('commentIds required');
    const ids = body.commentIds.filter((x): x is string => typeof x === 'string');
    const res = await store.update((s): ExportResponse => {
      const now = new Date().toISOString();
      const selected: Comment[] = [];
      for (const id of ids) {
        const found = findComment(s, id);
        if (!found) continue;
        const next: Comment = { ...found.comment, exportedAt: now, updatedAt: now };
        if (next.status === 'active') next.status = 'exported';
        s.targets[found.targetKey]!.comments[found.index] = next;
        selected.push(next);
      }
      return {
        text: formatCommentsExport({ repoRoot: repo.root, comments: selected }),
        count: selected.length,
        commentIds: selected.map((x) => x.id),
      };
    });
    return c.json(res);
  });

  // ---- issues ------------------------------------------------------------

  api.get('/issues', async (c) => {
    const s = await store.load();
    return c.json({ issues: s.issues });
  });

  api.post('/issues', async (c) => {
    const body = (await c.req.json()) as CreateIssueRequest;
    if (!body.title || !body.title.trim()) throw badRequest('title is required');
    const now = new Date().toISOString();
    const issue: Issue = {
      id: randomUUID(),
      title: body.title.trim(),
      body: typeof body.body === 'string' ? body.body : '',
      status: body.status === 'closed' ? 'closed' : 'open',
      commentIds: Array.isArray(body.commentIds) ? body.commentIds.filter((x): x is string => typeof x === 'string') : [],
      createdAt: now,
      updatedAt: now,
    };
    // The list is in the reviewer's own order: a new issue goes on top, or under the one it was
    // typed after (Enter at the end of a row), like a task list.
    await store.update((s) => {
      s.issues = insertAfter(s.issues, issue, typeof body.after === 'string' ? body.after : undefined);
    });
    return c.json(issue, 201);
  });

  api.post('/issues/:id/move', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as MoveRequest;
    if (body.before !== null && typeof body.before !== 'string') throw badRequest('before must be an id or null');
    const issues = await store.update((s) => {
      const next = moveBefore(s.issues, id, body.before);
      if (!next) throw notFound('issue not found');
      s.issues = next;
      return s.issues;
    });
    return c.json({ issues });
  });

  api.patch('/issues/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as UpdateIssueRequest;
    const updated = await store.update((s) => {
      const issue = s.issues.find((i) => i.id === id);
      if (!issue) throw notFound('issue not found');
      if (typeof body.title === 'string' && body.title.trim()) issue.title = body.title.trim();
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.status === 'open' || body.status === 'closed') issue.status = body.status;
      if (Array.isArray(body.commentIds)) issue.commentIds = [...new Set(body.commentIds.filter((x): x is string => typeof x === 'string'))];
      issue.updatedAt = new Date().toISOString();
      return issue;
    });
    return c.json(updated);
  });

  api.delete('/issues/:id', async (c) => {
    const id = c.req.param('id');
    const removed = await store.update((s) => {
      const before = s.issues.length;
      s.issues = s.issues.filter((i) => i.id !== id);
      return s.issues.length !== before;
    });
    if (!removed) throw notFound('issue not found');
    return c.json({ ok: true });
  });

  api.post('/issues/:id/export', async (c) => {
    const id = c.req.param('id');
    const res = await store.update((s): ExportResponse => {
      const issue = s.issues.find((i) => i.id === id);
      if (!issue) throw notFound('issue not found');
      const now = new Date().toISOString();
      const comments: Comment[] = [];
      for (const cid of issue.commentIds) {
        const found = findComment(s, cid);
        if (!found) continue;
        const next: Comment = { ...found.comment, exportedAt: now, updatedAt: now };
        if (next.status === 'active') next.status = 'exported';
        s.targets[found.targetKey]!.comments[found.index] = next;
        comments.push(next);
      }
      return {
        text: formatIssueExport({ repoRoot: repo.root, issue, comments }),
        count: comments.length,
        commentIds: comments.map((x) => x.id),
      };
    });
    return c.json(res);
  });

  // ---- todos ---------------------------------------------------------------

  /** A root the server is willing to answer for: this worktree, the main one, or a listed sibling. */
  const knownRoot = async (rootParam?: string): Promise<string> => {
    if (!rootParam) return repo.root;
    if (rootParam === repo.root || rootParam === repo.commonRoot) return rootParam;
    if ((await worktrees()).some((w) => w.path === rootParam)) return rootParam;
    throw badRequest(`unknown root: ${rootParam}`, 'unknown_worktree');
  };

  api.get('/todos', async (c) => {
    const branch = c.req.query('branch') || undefined;
    const s = await store.load();
    const res: TodosResponse = {
      todos: branch ? s.todos.filter((t) => t.branch === branch) : s.todos,
      ...(branch ? { branch } : {}),
    };
    return c.json(res);
  });

  api.post('/todos', async (c) => {
    const body = (await c.req.json()) as CreateTodoRequest;
    if (!body.title || !body.title.trim()) throw badRequest('title is required');
    const branch = body.branch?.trim() || (await currentBranch(await knownRoot(body.root)));
    const now = new Date().toISOString();
    const todo: Todo = {
      id: randomUUID(),
      branch,
      title: body.title.trim(),
      body: typeof body.body === 'string' ? body.body : '',
      status: body.status === 'done' ? 'done' : 'open',
      createdAt: now,
      updatedAt: now,
    };
    await store.update((s) => {
      s.todos = insertAfter(s.todos, todo, typeof body.after === 'string' ? body.after : undefined);
    });
    return c.json(todo, 201);
  });

  api.post('/todos/:id/move', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as MoveRequest;
    if (body.before !== null && typeof body.before !== 'string') throw badRequest('before must be an id or null');
    const todos = await store.update((s) => {
      const next = moveBefore(s.todos, id, body.before);
      if (!next) throw notFound('todo not found');
      s.todos = next;
      return s.todos;
    });
    const res: TodosResponse = { todos };
    return c.json(res);
  });

  api.patch('/todos/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as UpdateTodoRequest;
    const updated = await store.update((s) => {
      const todo = s.todos.find((t) => t.id === id);
      if (!todo) throw notFound('todo not found');
      if (typeof body.title === 'string' && body.title.trim()) todo.title = body.title.trim();
      if (typeof body.body === 'string') todo.body = body.body;
      if (body.status === 'open' || body.status === 'done') todo.status = body.status;
      todo.updatedAt = new Date().toISOString();
      return todo;
    });
    return c.json(updated);
  });

  api.delete('/todos/:id', async (c) => {
    const id = c.req.param('id');
    const removed = await store.update((s) => {
      const before = s.todos.length;
      s.todos = s.todos.filter((t) => t.id !== id);
      return s.todos.length !== before;
    });
    if (!removed) throw notFound('todo not found');
    return c.json({ ok: true });
  });

  // ---- commits -----------------------------------------------------------

  api.get('/commits', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? 200);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 200, 1), 1000);
    // Pages are an offset into one walk from `ref`, not "everything before the last sha seen":
    // resuming from a sha only reaches that sha's ancestors, which in a history with merges
    // silently drops the other branch's commits at every page boundary.
    const offsetRaw = Number(c.req.query('offset') ?? 0);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const filePath = c.req.query('path') || undefined;
    const ref = c.req.query('ref') || undefined;
    const rootParam = c.req.query('root') || undefined;
    const q = (c.req.query('q') ?? '').trim();
    const author = (c.req.query('author') ?? '').trim();
    const firstParent = c.req.query('firstParent') === '1';
    let cwd = repo.root;
    if (rootParam) {
      const wt = (await worktrees()).find((w) => w.path === rootParam);
      if (!wt && rootParam !== repo.root) throw badRequest('unknown root', 'unknown_worktree');
      cwd = rootParam;
    }
    if (ref && !isValidRef(ref)) throw badRequest('invalid ref');
    if (filePath && (filePath.startsWith('/') || filePath.split('/').includes('..'))) throw badRequest('invalid path');
    if (q.length > 200 || author.length > 200) throw badRequest('search text too long');

    const args = ['log', `--max-count=${limit + 1}`, `--skip=${offset}`, `--format=${COMMIT_FORMAT}`];
    if (firstParent) args.push('--first-parent');
    // Both patterns are literal, case-insensitive substrings — what a search box promises.
    if (q || author) args.push('--fixed-strings', '--regexp-ignore-case');
    if (q) args.push(`--grep=${q}`);
    if (author) args.push(`--author=${author}`);
    if (ref) args.push(ref);
    if (filePath) args.push('--', filePath);
    let stdout = '';
    try {
      stdout = (await runGit(args, { cwd })).stdout;
    } catch (e) {
      if (e instanceof HttpError && e.code === 'git_failed') stdout = '';
      else throw e;
    }
    const rows = parseCommitLog(stdout);
    const hasMore = rows.length > limit;
    let commits = rows.slice(0, limit);
    // A search term that looks like a sha also resolves as one, so pasting a sha from a terminal
    // finds the commit even though the message does not mention it. Only on the first page: the
    // pages after it carry the same `q`, and the hit would repeat at the top of every one.
    if (q && offset === 0 && /^[0-9a-f]{4,40}$/i.test(q)) {
      const sha = await revParse(cwd, `${q}^{commit}`);
      if (sha && !commits.some((x) => x.sha === sha)) {
        const hit = parseCommitLog((await runGit(['log', '--max-count=1', `--format=${COMMIT_FORMAT}`, sha], { cwd })).stdout)[0];
        if (hit) commits = [hit, ...commits];
      }
    }
    const res: CommitsResponse = { commits, hasMore };
    return c.json(res);
  });

  // Where HEAD forked off a base: the commit a `base` target diffs against, with how far the two
  // sides have moved since. Its own route, not a field of the log, so that editing the base in the
  // Commits panel does not re-walk the history.
  api.get('/fork-point', async (c) => {
    const base = (c.req.query('base') ?? '').trim();
    if (!isValidRef(base)) throw badRequest('invalid base ref');
    const cwd = await knownRoot(c.req.query('root') || undefined);
    if (!(await refExists(cwd, base))) throw badRequest(`unknown ref: ${base}`, 'unknown_ref');
    // An unborn HEAD forked off nothing; the `base` target diffs it against the empty tree instead.
    const sha = (await refExists(cwd, 'HEAD')) ? await mergeBase(cwd, base, 'HEAD') : undefined;
    if (!sha) throw badRequest(`${base} and HEAD share no history`, 'no_merge_base');
    // `<only on base>\t<only on HEAD>`. `base` cannot contain `..`, so the range is ours.
    const counts = (await runGit(['rev-list', '--left-right', '--count', `${base}...HEAD`], { cwd })).stdout.trim().split(/\s+/);
    const res: ForkPointResponse = { base, sha, ahead: Number(counts[1] ?? 0), behind: Number(counts[0] ?? 0) };
    return c.json(res);
  });

  // ---- change events -------------------------------------------------------

  api.get('/events', async (c) => {
    const root = c.req.query('root') || repo.root;
    const known = root === repo.root || root === repo.commonRoot || (await worktrees()).some((w) => w.path === root);
    if (!known) throw badRequest(`unknown root: ${root}`, 'unknown_worktree');
    return streamSSE(c, async (stream) => {
      const watcher = watcherFor(root);
      // Writes are chained so an event arriving mid-heartbeat cannot interleave with it.
      let chain: Promise<unknown> = Promise.resolve();
      const enqueue = (write: () => Promise<unknown>) => {
        chain = chain.then(write).catch(() => stream.abort());
        return chain;
      };
      const release = watcher.subscribe((change) => {
        const event: ChangeEvent = { type: 'changed', ...change };
        void enqueue(() => stream.writeSSE({ event: 'changed', data: JSON.stringify(event) }));
      });
      stream.onAbort(release);
      try {
        while (!stream.aborted && !stream.closed) {
          await stream.sleep(SSE_HEARTBEAT_MS);
          if (stream.aborted || stream.closed) break;
          await enqueue(() => stream.write(': ping\n\n'));
        }
      } finally {
        release();
      }
    });
  });

  // ---- nvim --------------------------------------------------------------

  api.get('/nvim/instances', async (c) => {
    const root = c.req.query('root') || repo.root;
    const force = c.req.query('rescan') === '1';
    const scan = await nvim.scan(force);
    const instances = NvimService.matching(scan.instances, root);
    const state = await store.load();
    const preferred = state.prefs.nvimSocketByRoot[root];
    let selected: string | undefined;
    if (preferred && instances.some((i) => i.socket === preferred)) selected = preferred;
    else if (instances.length === 1) selected = instances[0]!.socket;
    const res: NvimInstancesResponse = { root, nvimAvailable: scan.nvimAvailable, instances, selected, scannedAt: scan.scannedAt };
    return c.json(res);
  });

  api.post('/nvim/select', async (c) => {
    const body = (await c.req.json()) as { root?: string; socket?: string };
    if (!body.root || !body.socket) throw badRequest('root and socket are required');
    await store.update((s) => {
      s.prefs.nvimSocketByRoot[body.root!] = body.socket!;
    });
    return c.json({ ok: true });
  });

  api.post('/nvim/open', async (c) => {
    const body = (await c.req.json()) as NvimOpenRequest;
    if (!body.socket || !body.absPath) throw badRequest('socket and absPath are required');
    if (!path.isAbsolute(body.absPath)) throw badRequest('absPath must be absolute');
    const scan = await nvim.scan();
    if (!scan.instances.some((i) => i.socket === body.socket)) {
      const fresh = await nvim.scan(true);
      if (!fresh.instances.some((i) => i.socket === body.socket)) throw badRequest('nvim instance not found (rescan)', 'nvim_gone');
    }
    try {
      await nvim.open(body.socket, body.absPath, Number(body.line) || 1);
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : String(e), 'nvim_failed');
    }
    return c.json({ ok: true });
  });

  app.route('/api', api);
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/') || c.req.path === '/api') return c.json({ error: 'not found', code: 'not_found' }, 404);
    return c.text('Not Found', 404);
  });

  if (opts.webDir) {
    const webDir = opts.webDir;
    app.get('*', (c) => {
      if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.notFound();
      return serveStaticFile(c, webDir);
    });
  }
  return app;
}
