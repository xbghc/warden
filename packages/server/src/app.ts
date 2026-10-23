import path from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  ChangeEvent,
  CommitsResponse,
  CreateTodoRequest,
  CreateWorktreeRequest,
  ForkPointResponse,
  FileDiff,
  FileEntry,
  FilesResponse,
  FullFileResponse,
  MoveRequest,
  Prefs,
  ReleaseWorktreeRequest,
  RemoteBranchesResponse,
  RemoveWorktreeRequest,
  RepoInfo,
  StateEvent,
  Todo,
  TodosResponse,
  UpdateNotice,
  UpdateTodoRequest,
  WorktreeInfo,
  WorktreesResponse,
} from '@warden/shared';
import { formatTargetKey, insertAfter, isLocalTarget, isValidRef, moveBefore, tryParseTargetKey } from '@warden/shared';
import { badRequest, HttpError, notFound } from './errors.js';
import { COMMIT_FORMAT, parseCommitLog } from './commits.js';
import { mergeBase, refExists, revParse, runGit } from './git.js';
import { currentBranch, getRepoInfo, listWorktrees, remoteDefault, slotPath, type RepoContext } from './repo.js';
import { getFileDiff, getFullFile, listTargetDiffs, literal, resolveTargetContext, toSummary, type TargetContext } from './targets.js';
import { checkoutWorktree, listBranches, listWorktreesDetailed, lookupRemoteBranches, nextSlot, releaseWorktree, removeWorktree } from './worktrees.js';
import { forgetWorktreeTargets, type StateStore } from './state.js';
import { formatTodoExport } from './export.js';
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
      // Finish requests before draining watcher activity and state reads.
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([...requests]);
      for (const stop of stopStreams) stop();
      results.push(...(await Promise.allSettled([...stateReads, ...[...watchers.values()].map((watcher) => watcher.close())])));
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

  /** The target and the directory it is read in; validated against the repository checkout listing. */
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
  // origin driving that browser, which could commit changes or remove a worktree. Browsers label such
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
    const own = repo.root === repo.commonRoot ? 'all' : formatTargetKey({ kind: 'all', worktree: repo.root });
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
      (repo.root === repo.commonRoot || target.worktree === repo.root);
    if (last && usable) info.defaultTarget = isLocalTarget(target) ? formatTargetKey({ kind: 'all', worktree: target.worktree }) : last;
    else if (last) {
      if (repo.root === repo.commonRoot) {
        await store.update((s) => {
          s.prefs.lastTarget = 'all';
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
    const files: FileEntry[] = diffs.map(toSummary);
    const res: FilesResponse = { targetKey: key, root: ctx.cwd, files };
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

  api.post('/todos/:id/export', async (c) => {
    const todo = (await store.load()).todos.find((row) => row.id === c.req.param('id'));
    if (!todo) throw notFound('todo not found');
    return c.json({ text: formatTodoExport(todo) });
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
  api.post('/preview/setup', async (c) => c.json(await preview.setup()));
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
    await store.withRepositoryLock(() =>
      store.update((state) => {
        state.workspaceConfig = config;
      }),
    );
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
  api.post('/workflow/changes/:id/deliver', async (c) => c.json(await workflow.deliver(c.req.param('id'), await c.req.json())));

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
    const trunk = await remoteDefault(repo.commonRoot).catch(() => undefined);
    const res: WorktreesResponse = { worktrees: list, branches, newSlot, slotKind: state.prefs.slotKind ?? 'shared', ...(trunk ? { trunk } : {}) };
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
    if (body.kind !== undefined && body.kind !== 'shared' && body.kind !== 'clone' && body.kind !== 'worktree')
      throw badRequest('kind must be shared, clone or worktree', 'invalid_kind');
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
      // Detect writes from this page and other Warden instances; each write replaces the file.
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
