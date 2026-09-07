import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type {
  Comment,
  CommitInfo,
  CommitsResponse,
  CreateCommentRequest,
  CreateIssueRequest,
  ExportRequest,
  ExportResponse,
  FileDiff,
  FileEntry,
  FilesResponse,
  FullFileResponse,
  Issue,
  NvimInstancesResponse,
  NvimOpenRequest,
  Prefs,
  ReanchorRequest,
  ReanchorResponse,
  RepoInfo,
  ReviewState,
  UpdateCommentRequest,
  UpdateIssueRequest,
  WorktreeInfo,
} from '@warden/shared';
import { isValidRef } from '@warden/shared';
import { badRequest, HttpError, notFound } from './errors.js';
import { runGit } from './git.js';
import { getRepoInfo, listWorktrees, type RepoContext } from './repo.js';
import { getFileDiff, getFullFile, listTargetDiffs, resolveTargetContext, toSummary, type TargetContext } from './targets.js';
import { buildAnchor, reanchorComment } from './anchor.js';
import { ensureTarget, StateStore } from './state.js';
import { formatCommentsExport, formatIssueExport } from './export.js';
import { NvimService } from './nvim.js';
import { serveStaticFile } from './static.js';


export interface AppOptions {
  repo: RepoContext;
  store: StateStore;
  nvim?: NvimService;
  /** Directory of the built web app; when omitted only /api is served. */
  webDir?: string;
}

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

  const decodeKey = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw badRequest('malformed target key', 'invalid_target');
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

  api.get('/repo', async (c) => {
    const state = await store.load();
    const info: RepoInfo = await getRepoInfo(repo, state.prefs.lastTarget ?? 'working');
    worktreeCache = { at: Date.now(), list: info.worktrees };
    return c.json(info);
  });

  api.get('/state', async (c) => c.json(await store.load()));

  api.patch('/prefs', async (c) => {
    const body = (await c.req.json()) as Partial<Prefs>;
    const prefs = await store.update((s) => {
      if (body.viewMode === 'unified' || body.viewMode === 'split') s.prefs.viewMode = body.viewMode;
      if (typeof body.lastTarget === 'string') s.prefs.lastTarget = body.lastTarget;
      if (body.nvimSocketByRoot && typeof body.nvimSocketByRoot === 'object') {
        s.prefs.nvimSocketByRoot = { ...s.prefs.nvimSocketByRoot, ...body.nvimSocketByRoot };
      }
      return s.prefs;
    });
    return c.json(prefs);
  });

  // ---- targets -----------------------------------------------------------

  api.get('/targets/:key/files', async (c) => {
    const key = decodeKey(c.req.param('key'));
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
    const res: FilesResponse = { targetKey: key, root: ctx.cwd, files, comments: t?.comments ?? [] };
    return c.json(res);
  });

  api.get('/targets/:key/file', async (c) => {
    const key = decodeKey(c.req.param('key'));
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
    const key = decodeKey(c.req.param('key'));
    const filePath = c.req.query('path');
    if (!filePath) throw badRequest('missing path');
    const side = c.req.query('side') === 'old' ? 'old' : 'new';
    const ctx = await targetCtx(key);
    const content = await getFullFile(ctx, filePath, side);
    const res: FullFileResponse = { path: filePath, side, content };
    return c.json(res);
  });

  api.put('/targets/:key/viewed', async (c) => {
    const key = decodeKey(c.req.param('key'));
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

  // ---- comments ----------------------------------------------------------

  api.get('/targets/:key/comments', async (c) => {
    const key = decodeKey(c.req.param('key'));
    const state = await store.load();
    return c.json({ comments: state.targets[key]?.comments ?? [] });
  });

  api.post('/targets/:key/comments', async (c) => {
    const key = decodeKey(c.req.param('key'));
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
      ensureTarget(s, key).comments.push(comment);
    });
    return c.json(comment, 201);
  });

  api.patch('/targets/:key/comments/:id', async (c) => {
    const key = decodeKey(c.req.param('key'));
    const id = c.req.param('id');
    const ctx = await targetCtx(key);
    const body = (await c.req.json()) as UpdateCommentRequest;
    const state = await store.load();
    const existing = state.targets[key]?.comments.find((x) => x.id === id);
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
      };
    }
    const updated = await store.update((s) => {
      const t = ensureTarget(s, key);
      const idx = t.comments.findIndex((x) => x.id === id);
      if (idx < 0) throw notFound('comment not found');
      const next: Comment = { ...t.comments[idx]!, ...patch, updatedAt: new Date().toISOString() };
      t.comments[idx] = next;
      return next;
    });
    return c.json(updated);
  });

  api.delete('/targets/:key/comments/:id', async (c) => {
    const key = decodeKey(c.req.param('key'));
    const id = c.req.param('id');
    const removed = await store.update((s) => {
      const t = s.targets[key];
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
    const key = decodeKey(c.req.param('key'));
    const ctx = await targetCtx(key);
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as ReanchorRequest;
    const provided = new Map<string, FileDiff>();
    for (const f of body.files ?? []) if (f && typeof f.path === 'string' && Array.isArray(f.hunks)) provided.set(f.path, f);

    const state = await store.load();
    const comments = state.targets[key]?.comments ?? [];
    const paths = [...new Set(comments.map((x) => x.filePath))];
    const diffs = new Map<string, FileDiff | undefined>();
    await Promise.all(
      paths.map(async (p) => {
        if (provided.has(p)) {
          diffs.set(p, provided.get(p));
          return;
        }
        try {
          diffs.set(p, await fileDiffWithHints(ctx, p));
        } catch {
          diffs.set(p, undefined);
        }
      }),
    );
    const now = new Date().toISOString();
    const result = await store.update((s) => {
      const t = ensureTarget(s, key);
      t.comments = t.comments.map((cm) => reanchorComment(cm, diffs.get(cm.filePath), now));
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
      status: 'open',
      commentIds: Array.isArray(body.commentIds) ? body.commentIds.filter((x): x is string => typeof x === 'string') : [],
      createdAt: now,
      updatedAt: now,
    };
    await store.update((s) => {
      s.issues.push(issue);
    });
    return c.json(issue, 201);
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

  // ---- commits -----------------------------------------------------------

  api.get('/commits', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? 200);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 200, 1), 1000);
    const before = c.req.query('before') || undefined;
    const filePath = c.req.query('path') || undefined;
    const ref = c.req.query('ref') || undefined;
    const rootParam = c.req.query('root') || undefined;
    let cwd = repo.root;
    if (rootParam) {
      const wt = (await worktrees()).find((w) => w.path === rootParam);
      if (!wt && rootParam !== repo.root) throw badRequest('unknown root', 'unknown_worktree');
      cwd = rootParam;
    }
    if (before && !isValidRef(before)) throw badRequest('invalid before ref');
    if (ref && !isValidRef(ref)) throw badRequest('invalid ref');
    if (filePath && (filePath.startsWith('/') || filePath.split('/').includes('..'))) throw badRequest('invalid path');

    const SEP = '\x1f';
    const args = ['log', `--max-count=${limit + 1}`, `--format=%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%P${SEP}%s`];
    if (before) args.push(before);
    else if (ref) args.push(ref);
    if (filePath) args.push('--', filePath);
    let stdout = '';
    try {
      stdout = (await runGit(args, { cwd })).stdout;
    } catch (e) {
      if (e instanceof HttpError && e.code === 'git_failed') stdout = '';
      else throw e;
    }
    let commits: CommitInfo[] = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', shortSha = '', author = '', email = '', date = '', parents = '', ...rest] = line.split(SEP);
        return { sha, shortSha, author, email, date, parents: parents.split(' ').filter(Boolean), subject: rest.join(SEP) };
      });
    if (before) commits = commits.filter((x) => x.sha !== before && !x.sha.startsWith(before));
    const hasMore = commits.length > limit;
    const res: CommitsResponse = { commits: commits.slice(0, limit), hasMore };
    return c.json(res);
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
    app.get('*', (c) => serveStaticFile(c, webDir));
  }
  return app;
}
