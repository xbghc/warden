import path from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  ChangeEvent,
  CheckpointsResponse,
  CreateCheckpointResponse,
  Comment,
  CommitsResponse,
  CreateCommentRequest,
  CreateTodoRequest,
  CreateWorktreeRequest,
  ExportRequest,
  ExportResponse,
  ForkPointResponse,
  FileDiff,
  FileEntry,
  FilesResponse,
  FullFileResponse,
  MoveRequest,
  Prefs,
  ReanchorRequest,
  ReanchorResponse,
  ReleaseWorktreeRequest,
  ReplyRequest,
  RemoteBranchesResponse,
  RemoveWorktreeRequest,
  RepoInfo,
  ReviewState,
  StateEvent,
  StageRequest,
  StageResponse,
  Todo,
  TodosResponse,
  UpdateCommentRequest,
  UpdateNotice,
  UpdateTodoRequest,
  WorktreeInfo,
  WorktreeReview,
  WorktreesResponse,
} from '@warden/shared';
import {
  awaitsAgent,
  awaitsReviewer,
  commentWorktree,
  commentScopeKey,
  formatTargetKey,
  insertAfter,
  isLocalTarget,
  isValidRef,
  localViewKeys,
  moveBefore,
  stageModeFor,
  tracksViewed,
  tryParseTargetKey,
} from '@warden/shared';
import { badRequest, HttpError, notFound } from './errors.js';
import { COMMIT_FORMAT, parseCommitLog } from './commits.js';
import { applyToIndex, mergeBase, refExists, revParse, runGit } from './git.js';
import { currentBranch, getRepoInfo, listWorktrees, remoteDefault, slotPath, type RepoContext } from './repo.js';
import { annotateDebug, getFileDiff, getFullFile, listTargetDiffs, literal, resolveTargetContext, toSummary, type TargetContext } from './targets.js';
import { buildAnchor, reanchorComment } from './anchor.js';
import { buildStagePatch } from './patch.js';
import { checkpointKey, checkpointStore, checkpointsOf, findCheckpoint, forgetCheckpoint, takeCheckpoint } from './checkpoints.js';
import { checkoutWorktree, listBranches, listWorktreesDetailed, lookupRemoteBranches, nextSlot, releaseWorktree, removeWorktree } from './worktrees.js';
import { ensureTarget, forgetWorktreeTargets, type StateStore, unlinkComments } from './state.js';
import { formatCommentsExport, formatTodoExport } from './export.js';
import { addReply } from './feedback.js';
import { WorkflowService } from './workflow.js';
import { PreviewService } from './preview.js';
import { HistoryService } from './history.js';
import { listSafetyBackups } from './backups.js';
import { workspaceConfig } from './workspace.js';
import { DEFAULT_POLL_INTERVAL_MS, RepoWatcher } from './watcher.js';
import { serveStaticFile } from './static.js';

export interface AppOptions {
  repo: RepoContext;
  store: StateStore;
  /** Directory of the built web app; when omitted only /api is served. */
  webDir?: string;
  /** Poll interval of the repository watchers; tests use a short one. */
  watchIntervalMs?: number;
  /** Echoed by GET /api/ping, so a caller can tell this process apart from whatever else answers. */
  instanceToken?: string;
  /** The CLI's update check, still in flight when the first page loads; it never rejects. */
  update?: Promise<UpdateNotice | null>;
  /** How an agent runs the CLI (`warden`, `npx @xbghc/warden`); exports tell it to reply that way. */
  replyCommand?: string;
}

const SSE_HEARTBEAT_MS = 15_000;

/** The names a browser on this machine reaches the server by; anything else arrived by way of DNS. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

interface ListingCache {
  at: number;
  files: FileDiff[];
}

const LISTING_HINT_TTL_MS = 5 * 60_000;

export type WardenApp = Hono & { close(): Promise<void> };

export function createApp(opts: AppOptions): WardenApp {
  const { repo, store } = opts;
  const app = new Hono() as WardenApp;
  let stopped = false;
  let closing: Promise<void> | undefined;
  const requests = new Set<Promise<void>>();
  const stateReads = new Set<Promise<number>>();
  const backgroundCheckpoints = new Set<Promise<unknown>>();
  const stopStreams = new Set<() => void>();
  app.use('*', async (c, next) => {
    if (stopped) return c.json({ error: 'Server is closing', code: 'server_closing' }, 503);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    requests.add(pending);
    try {
      await next();
    } finally {
      requests.delete(pending);
      finish();
    }
  });

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
  app.close = () => {
    if (closing) return closing;
    stopped = true;
    for (const stop of stopStreams) stop();
    closing = (async () => {
      // An export already in flight can schedule its checkpoint after shutdown
      // starts. Finish those requests before capturing the background work to drain.
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([...requests]);
      for (const stop of stopStreams) stop();
      results.push(...(await Promise.allSettled([...backgroundCheckpoints, ...stateReads, ...[...watchers.values()].map((watcher) => watcher.close())])));
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Failed to close repository activity');
    })();
    return closing;
  };

  let worktreeCache: { at: number; list: WorktreeInfo[] } | null = null;
  const worktrees = async (force = false): Promise<WorktreeInfo[]> => {
    if (!force && worktreeCache && Date.now() - worktreeCache.at < 10_000) return worktreeCache.list;
    const list = await listWorktrees(repo);
    worktreeCache = { at: Date.now(), list };
    return list;
  };

  const checkpoints = checkpointStore(store.file);

  const stateStamp = (): Promise<number> => {
    const reading = stat(store.file)
      .then(
        (st) => st.mtimeMs,
        () => 0,
      )
      .finally(() => stateReads.delete(reading));
    stateReads.add(reading);
    return reading;
  };

  /** The target and the directory it is read in; a checkpoint is not looked up (see `targetCtx`). */
  const worktreeCtx = async (key: string): Promise<TargetContext> => {
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

  const targetCtx = async (key: string): Promise<TargetContext> => {
    const ctx = await worktreeCtx(key);
    if (ctx.target.kind !== 'checkpoint') return ctx;
    const cp = findCheckpoint(await store.load(), ctx.target.worktree, ctx.target.id);
    if (!cp) throw notFound(`no checkpoint #${ctx.target.id} in this worktree`, 'unknown_checkpoint');
    return { ...ctx, checkpoint: { tree: cp.tree, store: checkpoints } };
  };

  const fileDiffWithHints = async (ctx: TargetContext, filePath: string, explicit?: { oldPath?: string; untracked?: boolean }) => {
    const cached = listings.get(ctx.key);
    const hint = cached && Date.now() - cached.at < LISTING_HINT_TTL_MS ? cached.files.find((f) => f.path === filePath) : undefined;
    return getFileDiff(ctx, filePath, {
      oldPath: explicit?.oldPath ?? hint?.oldPath,
      untracked: explicit?.untracked ?? hint?.untracked,
    });
  };

  // Handing comments to the agent ends a round, so the working tree is noted then: what the agent
  // does about them is `checkpoint:<n>`, the view the reviewer comes back to. It runs after the
  // response, not before: the page writes the clipboard when the export returns, which a browser
  // allows only shortly after the click, and a snapshot of a large tree can take longer than that.
  // The page hears of the checkpoint through the state event.
  const checkpointHandoff = (comments: Comment[]): void => {
    const worktrees = new Set(comments.map((x) => tryParseTargetKey(x.targetKey)?.worktree));
    for (const wt of worktrees) {
      const pending = takeCheckpoint(store, wt ?? repo.commonRoot, wt, { handoff: true })
        .catch((e) => {
          console.error(`warden: no checkpoint for the comments handed over in ${wt ?? repo.commonRoot}: ${e instanceof Error ? e.message : e}`);
        })
        .finally(() => backgroundCheckpoints.delete(pending));
      backgroundCheckpoints.add(pending);
    }
  };

  const findComment = (state: ReviewState, id: string): { comment: Comment; targetKey: string; index: number } | undefined => {
    for (const [targetKey, t] of Object.entries(state.targets)) {
      const index = t.comments.findIndex((c) => c.id === id);
      if (index >= 0) return { comment: t.comments[index]!, targetKey, index };
    }
    return undefined;
  };

  /** The ids of a request that name existing comments, each once; any other is refused rather than kept dangling. */
  const linkable = (state: ReviewState, raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw badRequest('commentIds must be a list of ids');
    const ids = [...new Set(raw as string[])];
    const missing = ids.find((x) => !findComment(state, x));
    if (missing) throw notFound(`no comment with id ${missing}`, 'unknown_comment');
    return ids;
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : String(err), code: 'internal' }, 500);
  });

  // Binding to 127.0.0.1 keeps other machines out, not other sites: a domain whose DNS answer is
  // switched to 127.0.0.1 after its page loads (DNS rebinding) makes that page same-origin with
  // this server, free to read every diff and drive every write. The one thing it cannot change is
  // the name it was loaded under, which the browser sends as Host, so only loopback names pass.
  app.use('*', async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new HttpError(403, `requests for host ${host} are refused; open warden at http://127.0.0.1 or http://localhost`, 'bad_host');
    }
    await next();
  });

  const api = new Hono();

  // The server trusts the browser it was opened in; what it must not trust is a page from another
  // origin driving that browser, which could stage lines or remove a worktree. Browsers label such
  // requests with Sec-Fetch-Site, and with Origin — the older and wider-supported of the two — so a
  // write carrying either sign of another origin is refused before any route sees it. Reads stay
  // open: with Host checked above, a page from elsewhere cannot read the response.
  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(c.req.url).origin)) {
        throw new HttpError(403, 'cross-site requests are refused', 'cross_site');
      }
    }
    await next();
  });

  // Cheap identity check: no git, no state file. See wsl.ts for who asks and why.
  api.get('/ping', (c) => c.text(opts.instanceToken ?? ''));

  api.get('/repo', async (c) => {
    const state = await store.load();
    // Started inside a linked worktree, the page opens that worktree: its own keys carry its path.
    const own = repo.root === repo.commonRoot ? 'working' : formatTargetKey({ kind: 'working', worktree: repo.root });
    const info: RepoInfo = await getRepoInfo(repo, own);
    worktreeCache = { at: Date.now(), list: info.worktrees };
    // The remembered target is handed back only while it can still be opened. One inside a
    // worktree that has since been removed would strand the page on an error: everything it
    // could click next carries that worktree along, and the next load would land there again.
    const last = state.prefs.lastTarget;
    const target = last ? tryParseTargetKey(last) : undefined;
    const usable =
      !!target &&
      (!target.worktree || info.worktrees.some((w) => w.path === target.worktree)) &&
      // A server started in a linked worktree is there to review that one, not whatever the main
      // worktree's page last looked at: the preference is shared by every server on the repository.
      (repo.root === repo.commonRoot || target.worktree === repo.root) &&
      (target.kind !== 'checkpoint' || !!findCheckpoint(state, target.worktree, target.id));
    if (last && usable) info.defaultTarget = last;
    else if (last) {
      if (repo.root === repo.commonRoot) {
        await store.update((s) => {
          s.prefs.lastTarget = 'working';
        });
      }
    }
    return c.json(info);
  });

  api.get('/state', async (c) => c.json(await store.load()));

  // Waits for the check rather than answering "nothing yet": the request behind it gives up after a
  // few seconds, and the page asks once, off to the side of everything it needs to draw.
  api.get('/update', async (c) => c.json((await opts.update) ?? null));

  api.patch('/prefs', async (c) => {
    const body = (await c.req.json()) as Partial<Prefs>;
    const prefs = await store.update((s) => {
      if (body.viewMode === 'unified' || body.viewMode === 'split') s.prefs.viewMode = body.viewMode;
      if (typeof body.lastTarget === 'string') s.prefs.lastTarget = body.lastTarget;
      if (body.lastPanel === 'orchestration' || body.lastPanel === 'diff' || body.lastPanel === 'commits') s.prefs.lastPanel = body.lastPanel;
      if (typeof body.autoRefresh === 'boolean') s.prefs.autoRefresh = body.autoRefresh;
      if (typeof body.railOpen === 'boolean') s.prefs.railOpen = body.railOpen;
      if (typeof body.ignoreDebug === 'boolean') s.prefs.ignoreDebug = body.ignoreDebug;
      return s.prefs;
    });
    return c.json(prefs);
  });

  // ---- targets -----------------------------------------------------------

  api.get('/targets/:key/files', async (c) => {
    const key = c.req.param('key');
    const ctx = await targetCtx(key);
    const diffs = await listTargetDiffs(ctx);
    await annotateDebug(ctx, diffs);
    listings.set(key, { at: Date.now(), files: diffs });
    const notices = changedNotices.get(key) ?? new Set<string>();
    changedNotices.set(key, notices);

    const stale: string[] = [];
    const state = await store.load();
    // The local views keep no 已读 mark (see `tracksViewed`), so there is nothing to check or to
    // report as changed; whatever an older version left under their keys is dropped on load.
    const viewed = tracksViewed(ctx.target) ? (state.targets[key]?.viewed ?? {}) : {};
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
    await annotateDebug(ctx, [diff]);
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
    const ctx = await targetCtx(key);
    if (!tracksViewed(ctx.target)) throw badRequest(`${key} keeps no viewed mark: a file there is reviewed once it is staged`, 'viewed_not_tracked');
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

  // ---- checkpoints -------------------------------------------------------

  // Any target key names the worktree whose checkpoints are meant, a checkpoint's own included.
  api.get('/targets/:key/checkpoints', async (c) => {
    const ctx = await worktreeCtx(c.req.param('key'));
    const res: CheckpointsResponse = { checkpoints: checkpointsOf(await store.load(), ctx.target.worktree) };
    return c.json(res);
  });

  api.post('/targets/:key/checkpoints', async (c) => {
    const ctx = await worktreeCtx(c.req.param('key'));
    const { checkpoint, unchanged } = await takeCheckpoint(store, ctx.cwd, ctx.target.worktree);
    const res: CreateCheckpointResponse = { checkpoint, unchanged, targetKey: checkpointKey(checkpoint) };
    return c.json(res, unchanged ? 200 : 201);
  });

  api.delete('/targets/:key/checkpoints/:id', async (c) => {
    const ctx = await worktreeCtx(c.req.param('key'));
    const id = Number(c.req.param('id'));
    await store.update((s) => {
      const cp = Number.isInteger(id) ? findCheckpoint(s, ctx.target.worktree, id) : undefined;
      if (!cp) throw notFound(`no checkpoint #${c.req.param('id')} in this worktree`, 'unknown_checkpoint');
      forgetCheckpoint(s, cp);
    });
    return c.json({ ok: true });
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
    if (body.skipDebug !== undefined && typeof body.skipDebug !== 'boolean') throw badRequest('skipDebug must be a boolean', 'bad_selection');
    const diff = await fileDiffWithHints(ctx, body.path);
    if (!diff) throw badRequest(`file ${body.path} is not part of ${key}`, 'no_diff');
    if (diff.conflicted) throw new HttpError(409, `${body.path} is in conflict; resolve it and git add it in the terminal`, 'conflicted');
    // The selection is a set of indices into a diff the client saw; against any other diff they
    // would name the wrong lines. The agent may well have edited the file since.
    if (diff.contentHash !== body.contentHash)
      throw new HttpError(409, 'the diff changed since it was loaded; refresh and pick the lines again', 'diff_changed');
    // Whether a line is debug code is read from the file as it is now, like the diff itself.
    if (body.skipDebug) await annotateDebug(ctx, [diff]);
    const { patch, lines } = buildStagePatch(diff, mode, body.hunks, { skipDebug: body.skipDebug });
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
      const prev = t.comments[idx]!;
      const next: Comment = { ...prev, ...patch, updatedAt: new Date().toISOString() };
      // A changed note is one the agent has not read: it goes out again, as a reviewer reply does.
      if (patch.body !== undefined && patch.body !== prev.body && next.exportedAt) {
        delete next.exportedAt;
        if (next.status === 'exported') next.status = 'active';
      }
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
      unlinkComments(s, [id]);
      return t.comments.length !== before;
    });
    if (!removed) throw notFound('comment not found');
    return c.json({ ok: true });
  });

  api.post('/targets/:key/comments/:id/replies', async (c) => {
    const body = (await c.req.json()) as ReplyRequest;
    if (typeof body.body !== 'string') throw badRequest('body is required');
    const found = findComment(await store.load(), c.req.param('id'));
    if (!found || found.targetKey !== commentScopeKey(c.req.param('key'))) throw notFound('comment not found');
    return c.json(await addReply(store, found.comment.id, 'reviewer', body.body), 201);
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

    // A comment with nowhere left to sit is finished work only if its lines went into a commit: HEAD
    // moved forward from where the last pass saw it, and the code it was on is in that stretch of
    // history. Anything else that moves HEAD — a branch switch, a reset, a stash and checkout, an
    // amend or rebase — leaves the comment orphaned for the reviewer, never deleted. Never on the
    // first pass, when there is no HEAD to compare to.
    const landed = new Set<string>();
    const lost = comments.filter((cm) => !located.has(cm.id));
    if (local && lost.length && prevHead && head && prevHead !== head && (await mergeBase(ctx.cwd, prevHead, head)) === prevHead) {
      const range = await worktreeCtx(
        formatTargetKey({ kind: 'range', base: prevHead, head, ...(ctx.target.worktree ? { worktree: ctx.target.worktree } : {}) }),
      );
      await Promise.all(
        lost.map(async (cm) => {
          const committedDiff = await getFileDiff(range, cm.filePath).catch(() => undefined);
          if (committedDiff && reanchorComment(cm, committedDiff, now).status !== 'orphaned') landed.add(cm.id);
        }),
      );
    }

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
          // A thread is a conversation the reviewer has not closed: the agent's answer usually
          // arrives with the very commit that makes the code it was about disappear, and dropping
          // the comment then would lose the answer unread.
          if (landed.has(cm.id) && !cm.replies?.length) {
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
      unlinkComments(s, dropped);
      t.head = head;
      return t.comments;
    });
    const res: ReanchorResponse = { comments: result };
    return c.json(res);
  });

  /**
   * Marks comments as handed to the agent and notes the working tree, as one hand-off. Kept apart
   * from building the text: the page asks for the text first (`preview`), writes the clipboard,
   * and only then confirms, so a clipboard that refused the text does not leave the comments
   * looking delivered.
   */
  const handOver = async (ids: string[]): Promise<Comment[]> => {
    const handed = await store.update((s): Comment[] => {
      const now = new Date().toISOString();
      const out: Comment[] = [];
      for (const id of ids) {
        const found = findComment(s, id);
        if (!found) continue;
        const next: Comment = { ...found.comment, exportedAt: now, updatedAt: now };
        if (next.status === 'active') next.status = 'exported';
        s.targets[found.targetKey]!.comments[found.index] = next;
        out.push(next);
      }
      return out;
    });
    checkpointHandoff(handed);
    return handed;
  };
  const existing = (state: ReviewState, ids: string[]): Comment[] => ids.flatMap((id) => findComment(state, id)?.comment ?? []);

  api.post('/comments/export', async (c) => {
    const body = (await c.req.json()) as ExportRequest;
    if (!Array.isArray(body.commentIds)) throw badRequest('commentIds required');
    const ids = body.commentIds.filter((x): x is string => typeof x === 'string');
    const comments = body.preview ? existing(await store.load(), ids) : await handOver(ids);
    const res: ExportResponse = {
      text: formatCommentsExport({ repoRoot: repo.root, comments, replyCommand: opts.replyCommand }),
      count: comments.length,
      commentIds: comments.map((x) => x.id),
    };
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
    if (!body.title?.trim()) throw badRequest('title is required');
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
      if (body.commentIds !== undefined) {
        const ids = linkable(s, body.commentIds);
        if (ids.length) todo.commentIds = ids;
      }
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
      if (body.commentIds !== undefined) {
        const ids = linkable(s, body.commentIds);
        if (ids.length) todo.commentIds = ids;
        else delete todo.commentIds;
      }
      todo.updatedAt = new Date().toISOString();
      return todo;
    });
    return c.json(updated);
  });

  // A todo with comments is what an issue was: a task with the review notes it is about, handed to
  // the agent together. So its copy is a hand-off, as copying the comments would be.
  api.post('/todos/:id/export', async (c) => {
    const id = c.req.param('id');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { preview?: boolean };
    const state = await store.load();
    const todo = state.todos.find((t) => t.id === id);
    if (!todo) throw notFound('todo not found');
    const ids = todo.commentIds ?? [];
    const comments = body.preview ? existing(state, ids) : await handOver(ids);
    const res: ExportResponse = {
      text: formatTodoExport({ todo, comments, replyCommand: opts.replyCommand }),
      count: comments.length,
      commentIds: comments.map((x) => x.id),
    };
    return c.json(res);
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

    // log.showSignature would print verification lines into the format, where they read as commits.
    const args = ['log', '--no-show-signature', `--max-count=${limit + 1}`, `--skip=${offset}`, `--format=${COMMIT_FORMAT}`];
    if (firstParent) args.push('--first-parent');
    // Both patterns are literal, case-insensitive substrings — what a search box promises.
    if (q || author) args.push('--fixed-strings', '--regexp-ignore-case');
    if (q) args.push(`--grep=${q}`);
    if (author) args.push(`--author=${author}`);
    if (ref) args.push(ref);
    args.push('--');
    if (filePath) args.push(literal(filePath));
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
        const hit = parseCommitLog((await runGit(['log', '--no-show-signature', '--max-count=1', `--format=${COMMIT_FORMAT}`, sha, '--'], { cwd })).stdout)[0];
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

  // ---- worktrees -----------------------------------------------------------

  const workflow = new WorkflowService(repo, store);
  const preview = new PreviewService(repo, store);
  const history = new HistoryService(repo, store);
  api.get('/preview', async (c) => c.json(await preview.get()));
  api.put('/preview', async (c) => c.json(await preview.set((await c.req.json())?.connectedIds)));
  api.post('/preview/refresh', async (c) => c.json(await preview.refresh()));
  api.get('/workflow/rebase-checks', async (c) => c.json(await workflow.rebaseChecks()));
  api.post('/workflow/rebase', async (c) => {
    const result = await workflow.rebaseBatch(await c.req.json());
    worktreeCache = null;
    return c.json(result);
  });
  api.get('/history', async (c) => c.json(await history.get()));
  api.post('/history/preview', async (c) => c.json(await history.preview(await c.req.json())));
  api.post('/history/apply', async (c) => c.json(await history.apply(await c.req.json())));
  api.put('/workspace/config', async (c) => {
    const config = workspaceConfig(await c.req.json());
    await store.update((state) => {
      state.workspaceConfig = config;
    });
    return c.json(config);
  });
  api.post('/workflow/changes/:id/hook', async (c) => c.json(await workflow.retryHook(c.req.param('id'))));
  api.get('/workflow', async (c) => c.json(await workflow.get()));
  api.put('/workflow', async (c) => {
    const body = await c.req.json();
    if (typeof body?.developmentBranch !== 'string') throw badRequest('developmentBranch is required');
    return c.json(await workflow.configure(body.developmentBranch));
  });
  api.post('/workflow/changes', async (c) => {
    const body = await c.req.json();
    if (!body || typeof body.title !== 'string' || (body.worktree !== undefined && typeof body.worktree !== 'string')) throw badRequest('invalid change');
    const result = await workflow.create(body);
    worktreeCache = null;
    return c.json(result, 201);
  });
  api.patch('/workflow/changes/:id', async (c) => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('invalid change');
    return c.json(await workflow.update(c.req.param('id'), body));
  });
  api.post('/workflow/changes/:id/start', async (c) => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('invalid assignment');
    const result = await workflow.start(c.req.param('id'), body);
    worktreeCache = null;
    return c.json(result);
  });
  api.post('/workflow/changes/:id/move', async (c) => c.json(await workflow.move(c.req.param('id'), (await c.req.json())?.before)));
  api.post('/workflow/import-todos/:id', async (c) => c.json(await workflow.importTodo(c.req.param('id'))));
  api.post('/workflow/changes/:id/sync', async (c) => {
    const body = await c.req.json();
    if (typeof body?.sourceHead !== 'string') throw badRequest('sourceHead is required');
    const result = await workflow.sync(c.req.param('id'), body.sourceHead);
    worktreeCache = null;
    return c.json(result);
  });
  api.post('/workflow/changes/:id/ready', async (c) => c.json(await workflow.ready(c.req.param('id'))));
  api.post('/workflow/changes/:id/resume', async (c) => c.json(await workflow.resume(c.req.param('id'))));
  api.post('/workflow/changes/:id/prepare', async (c) => {
    const result = await workflow.prepare(c.req.param('id'), await c.req.json());
    worktreeCache = null;
    return c.json(result);
  });
  api.post('/workflow/changes/:id/accept', async (c) => {
    const result = await workflow.accept(c.req.param('id'), await c.req.json());
    worktreeCache = null;
    return c.json(result);
  });

  const assertUnassigned = async (worktree: string) => {
    const held = (await store.load()).workflow?.changes.find(
      (row) => row.status !== 'accepted' && (row.worktree === worktree || row.integration?.worktree === worktree),
    );
    if (held) throw new HttpError(409, '该工位有进行中的任务，请通过任务的验证提交流程完成', 'active_change');
  };

  api.get('/worktrees', async (c) => {
    const [list, state] = await Promise.all([listWorktreesDetailed(repo), store.load()]);
    const [branches, newSlot] = await Promise.all([listBranches(repo, list), nextSlot(repo, list)]);
    // A key without a worktree is the main worktree's (see resolveTargetContext).
    const review = new Map<string, WorktreeReview>();
    const latest = new Map<string, { agent: string; reviewer: string }>();
    for (const t of Object.values(state.targets)) {
      for (const cm of t.comments) {
        const at = commentWorktree(cm) ?? repo.commonRoot;
        const r = review.get(at) ?? { toAgent: 0, toReviewer: 0 };
        const seen = latest.get(at) ?? { agent: '', reviewer: '' };
        if (awaitsAgent(cm)) {
          r.toAgent++;
          if (cm.updatedAt >= seen.agent) [seen.agent, r.toAgentTarget] = [cm.updatedAt, cm.targetKey];
        }
        if (awaitsReviewer(cm)) {
          r.toReviewer++;
          if (cm.updatedAt >= seen.reviewer) [seen.reviewer, r.toReviewerTarget] = [cm.updatedAt, cm.targetKey];
        }
        review.set(at, r);
        latest.set(at, seen);
      }
    }
    for (const wt of list) {
      const r = review.get(wt.path);
      if (r && (r.toAgent || r.toReviewer)) wt.review = r;
    }
    const trunk = await remoteDefault(repo.commonRoot).catch(() => undefined);
    const res: WorktreesResponse = { worktrees: list, branches, newSlot, slotKind: state.prefs.slotKind ?? 'clone', ...(trunk ? { trunk } : {}) };
    return c.json(res);
  });

  // One name at a time: the list above leaves remote branches out, since a remote can carry thousands.
  // A clone slot's are its own, so the slot the form points at says where to look.
  api.get('/worktrees/remotes', async (c) => {
    const slot = c.req.query('slot') ? Number(c.req.query('slot')) : undefined;
    if (slot !== undefined && (!Number.isInteger(slot) || slot < 1)) throw badRequest('slot must be a positive integer', 'invalid_slot');
    const res: RemoteBranchesResponse = { remotes: await lookupRemoteBranches(repo, c.req.query('branch') ?? '', slot) };
    return c.json(res);
  });

  // Checkout, release and removal each read the slots and then write one of them. Two at once would
  // both see slot 1 free and both switch into it, the second leaving the first branch dangling; run
  // one after the other, each reads what the last one did.
  let worktreeWrites: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = worktreeWrites.then(
      () => store.withRepositoryLock(fn),
      () => store.withRepositoryLock(fn),
    );
    worktreeWrites = run.catch(() => undefined);
    return run;
  };

  api.post('/worktrees', async (c) => {
    const body = (await c.req.json()) as CreateWorktreeRequest;
    if (typeof body.branch !== 'string') throw badRequest('branch is required');
    if (body.base !== undefined && typeof body.base !== 'string') throw badRequest('base must be a ref');
    if (body.slot !== undefined && (!Number.isInteger(body.slot) || body.slot < 1)) throw badRequest('slot must be a positive integer', 'invalid_slot');
    if (body.kind !== undefined && body.kind !== 'clone' && body.kind !== 'worktree') throw badRequest('kind must be clone or worktree', 'invalid_kind');
    if (body.fetch !== undefined && typeof body.fetch !== 'boolean') throw badRequest('fetch must be a boolean');
    const res = await oneAtATime(async () => {
      const held = (await store.load()).workflow?.changes.filter((row) => row.status !== 'accepted') ?? [];
      if (held.length && body.slot === undefined) {
        const list = await listWorktreesDetailed(repo);
        body.slot = list.find((row) => row.free && !held.some((change) => change.worktree === row.path))?.slot ?? (await nextSlot(repo, list)).slot;
      }
      if (body.slot !== undefined) await assertUnassigned(slotPath(repo, body.slot));
      return checkoutWorktree(repo, body);
    });
    worktreeCache = null;
    await store.update((s) => {
      // Whatever was reviewed in this slot before was another branch; its state does not carry over.
      forgetWorktreeTargets(s, res.worktree.path);
      // The kind a new slot was made as is the one the form offers next time, per repository.
      if (!res.reused && body.kind) s.prefs.slotKind = body.kind;
    });
    return c.json(res, 201);
  });

  api.post('/worktrees/release', async (c) => {
    const body = (await c.req.json()) as ReleaseWorktreeRequest;
    if (typeof body.path !== 'string') throw badRequest('path is required');
    const res = await oneAtATime(async () => {
      await assertUnassigned(path.resolve(body.path));
      return releaseWorktree(repo, body, store);
    });
    worktreeCache = null;
    return c.json(res);
  });

  api.post('/worktrees/remove', async (c) => {
    const body = (await c.req.json()) as RemoveWorktreeRequest;
    if (typeof body.path !== 'string') throw badRequest('path is required');
    const res = await oneAtATime(async () => {
      await assertUnassigned(path.resolve(body.path));
      return removeWorktree(repo, body, store);
    });
    worktreeCache = null;
    return c.json(res);
  });

  api.get('/backups', async (c) => c.json({ backups: await listSafetyBackups(store) }));

  // ---- change events -------------------------------------------------------

  api.get('/events', async (c) => {
    const root = c.req.query('root') || repo.root;
    const known = root === repo.root || root === repo.commonRoot || (await worktrees()).some((w) => w.path === root);
    if (!known) throw badRequest(`unknown root: ${root}`, 'unknown_worktree');
    if (stopped) return c.json({ error: 'Server is closing', code: 'server_closing' }, 503);
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
      let ended = false;
      let statePoll: ReturnType<typeof setInterval> | undefined;
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const stop = () => {
        if (ended) return;
        ended = true;
        clearInterval(statePoll);
        clearTimeout(heartbeat);
        wake?.();
        release();
        stream.abort();
        stopStreams.delete(stop);
      };
      stopStreams.add(stop);
      stream.onAbort(stop);
      // The page's own writes land here too; the agent's `warden reply` only lands here, since the
      // CLI writes the state file without a server. mtime is enough: every write is a rename.
      try {
        let stamp = await stateStamp();
        if (ended) return;
        // A connected client can now write the state without racing the initial
        // baseline and having its first update silently absorbed into that baseline.
        void enqueue(() => stream.write(': connected\n\n'));
        let reading = false;
        statePoll = setInterval(() => {
          if (reading || ended) return;
          reading = true;
          void stateStamp()
            .then((next) => {
              if (ended || next === stamp) return;
              stamp = next;
              const event: StateEvent = { type: 'state', at: new Date().toISOString() };
              void enqueue(() => stream.writeSSE({ event: 'state', data: JSON.stringify(event) }));
            })
            .finally(() => {
              reading = false;
            });
        }, opts.watchIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        while (!ended && !stream.closed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            heartbeat = setTimeout(resolve, SSE_HEARTBEAT_MS);
          });
          wake = undefined;
          if (ended || stream.closed) break;
          await enqueue(() => stream.write(': ping\n\n'));
        }
      } finally {
        stop();
      }
    });
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
