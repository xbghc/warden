import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CommitInfo, CommitRef, ForkPointResponse } from '@warden/shared';
import { formatTargetKey, parseTargetKey } from '@warden/shared';
import { api, ApiError } from '../api';
import { useStore } from '../store';

const PAGE = 200;
/** Refs a row shows inline; the rest fold into a "+N" that lists them on hover. */
const MAX_REFS = 3;

interface Filters {
  q: string;
  author: string;
  path: string;
}
const NO_FILTERS: Filters = { q: '', author: '', path: '' };
const sameFilters = (a: Filters, b: Filters) => a.q === b.q && a.author === b.author && a.path === b.path;

/** Local calendar day, which is what the list is grouped by. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(d: Date, now: Date): string {
  const key = dayKey(d);
  if (key === dayKey(now)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday)) return '昨天';
  return d.toLocaleDateString(undefined, {
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  });
}

/** `Fix the thing (#1234)`: the PR number is real information but not what the eye scans for. */
function splitSubject(subject: string): { text: string; pr: string | null } {
  const m = /^(.*?)\s*\((#\d+)\)\s*$/.exec(subject);
  return m ? { text: m[1] ?? '', pr: m[2] ?? null } : { text: subject, pr: null };
}

function Refs({ refs, head }: { refs: CommitRef[]; head: boolean }) {
  // git lists the branch HEAD is on first; a detached HEAD has no branch to name.
  const onBranch = head && refs[0]?.kind === 'branch';
  if (refs.length === 0 && !head) return null;
  const shown = refs.slice(0, MAX_REFS);
  const rest = refs.length - shown.length;
  const all = refs.map((r) => (r.kind === 'tag' ? `tag: ${r.name}` : r.name)).join(', ');
  return (
    <span className="refs" title={all}>
      {head && !onBranch && <span className="ref ref-head">HEAD</span>}
      {shown.map((r, i) => (
        <span key={`${r.kind}:${r.name}`} className={`ref ref-${r.kind} ${onBranch && i === 0 ? 'ref-head' : ''}`}>
          {r.name}
        </span>
      ))}
      {rest > 0 && <span className="ref ref-more">+{rest}</span>}
    </span>
  );
}

type Row = { kind: 'day'; key: string; label: string } | { kind: 'commit'; c: CommitInfo };

type ForkState = { kind: 'ok'; base: string; fork: ForkPointResponse } | { kind: 'error'; base: string; message: string };

/** Beside the *Branch vs* field: where HEAD forked off the base, and how far each side has moved since. */
function ForkNote({ state, shortSha, onPick }: { state: ForkState; shortSha: (sha: string) => string; onPick: (sha: string) => void }) {
  if (state.kind === 'error') return <span className="fork-note muted">{state.message}</span>;
  const { base, sha, ahead, behind } = state.fork;
  if (ahead === 0 && behind === 0) return <span className="fork-note muted">与 {base} 相同</span>;
  return (
    <span className="fork-note muted">
      分叉于{' '}
      <button type="button" className="link mono" onClick={() => onPick(sha)} title={`${sha}\n查看这个提交`}>
        {shortSha(sha)}
      </button>{' '}
      · 领先 {ahead} · 落后 {behind}
    </span>
  );
}

export function CommitsPanel({ active }: { active: boolean }) {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repo);
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);
  const showToast = useStore((s) => s.showToast);
  const sideSlot = useStore((s) => s.sideSlot);
  const head = useStore((s) => s.repo?.worktrees.find((w) => w.path === s.root)?.head ?? s.repo?.head ?? '');

  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [firstParent, setFirstParent] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const seq = useRef(0);

  const target = useMemo(() => parseTargetKey(targetKey), [targetKey]);
  const wt = target.worktree ? { worktree: target.worktree } : {};
  const currentSha = target.kind === 'commit' ? target.sha : null;

  // The two history targets a click on a row cannot express. Where the branch under review most
  // likely forked off: the main worktree's branch when a sibling worktree is in view, otherwise
  // main / master if the repository has one.
  const mainWorktree = repo?.worktrees.find((w) => w.isMain);
  const suggestedBase = (root !== mainWorktree?.path && mainWorktree?.branch) || repo?.defaultBase || 'main';
  const [baseRef, setBaseRef] = useState(target.kind === 'base' ? target.ref : '');
  const [rangeBase, setRangeBase] = useState(target.kind === 'range' ? target.base : '@');
  const [rangeHead, setRangeHead] = useState(target.kind === 'range' ? target.head : '');
  const compareBranch = () => void setTarget(formatTargetKey({ kind: 'base', ref: baseRef.trim() || suggestedBase, ...wt }));
  const compareRange = () => {
    const h = rangeHead.trim();
    if (h) void setTarget(formatTargetKey({ kind: 'range', base: rangeBase.trim() || '@', head: h, ...wt }));
  };

  // Where HEAD forked off the base in the field (or the suggested one). Looked up apart from the
  // list, so editing the field does not re-walk the history; `head` is a dependency because a
  // commit landing moves the counts.
  const effectiveBase = baseRef.trim() || suggestedBase;
  const [fork, setFork] = useState<ForkState | null>(null);
  const forkSeq = useRef(0);
  useEffect(() => {
    const id = ++forkSeq.current;
    const t = setTimeout(async () => {
      try {
        const res = await api.forkPoint({ root, base: effectiveBase });
        if (id === forkSeq.current) setFork({ kind: 'ok', base: effectiveBase, fork: res });
      } catch (e) {
        if (id !== forkSeq.current) return;
        // A half-typed ref is not worth a message; anything else is said in place, never as a toast.
        if (e instanceof ApiError && e.code === 'unknown_ref') setFork(null);
        else if (e instanceof ApiError && e.code === 'no_merge_base')
          setFork({ kind: 'error', base: effectiveBase, message: `与 ${effectiveBase} 没有共同历史` });
        else setFork({ kind: 'error', base: effectiveBase, message: e instanceof Error ? e.message : String(e) });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [root, effectiveBase, head]);
  // A result for the base the field no longer names is not shown while the new one is on its way.
  const forkShown = fork?.base === effectiveBase ? fork : null;
  const forkSha = forkShown?.kind === 'ok' && (forkShown.fork.ahead > 0 || forkShown.fork.behind > 0) ? forkShown.fork.sha : null;
  const pickCommit = (sha: string) => void setTarget(formatTargetKey({ kind: 'commit', sha, ...wt }));

  // Typing settles for a moment before it reaches git; Enter applies at once.
  const apply = useCallback((next: Filters) => setFilters((prev) => (sameFilters(prev, next) ? prev : next)), []);
  useEffect(() => {
    const t = setTimeout(() => apply(draft), 300);
    return () => clearTimeout(t);
  }, [draft, apply]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') apply(draft);
  };

  // Every page is an offset into one walk that starts at the HEAD seen when the list was (re)loaded,
  // so a commit landing between two pages cannot shift the second one onto rows already shown.
  const anchor = useRef(head);
  const load = useCallback(
    async (opts: { offset?: number; limit?: number } = {}) => {
      // A slow response must not land on top of a newer query's rows.
      const id = ++seq.current;
      setLoading(true);
      try {
        const res = await api.commits({
          root,
          ref: anchor.current || undefined,
          q: filters.q || undefined,
          author: filters.author || undefined,
          path: filters.path || undefined,
          firstParent,
          offset: opts.offset,
          limit: opts.limit ?? PAGE,
        });
        if (id !== seq.current) return;
        setCommits((prev) => {
          if (!opts.offset) return res.commits;
          const known = new Set(prev.map((c) => c.sha));
          return [...prev, ...res.commits.filter((c) => !known.has(c.sha))];
        });
        setHasMore(res.hasMore);
      } catch (e) {
        if (id === seq.current) showToast(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [root, filters, firstParent, showToast],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  const loaded = useRef(0);
  loaded.current = commits.length;
  const seenHead = useRef(head);

  // A new root or query starts over from the top.
  useEffect(() => {
    setCommits([]);
    setHasMore(false);
    scrollTop.current = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
    // `head` is read here, not reacted to: the effect below owns HEAD changes.
    seenHead.current = head;
    anchor.current = head;
    void load();
  }, [load]);

  // HEAD moved (a commit landed, a branch was checked out): re-read what is on screen from the
  // new HEAD, so the new rows appear at the top without dropping the pages already scrolled through.
  useEffect(() => {
    if (seenHead.current === head) return;
    seenHead.current = head;
    anchor.current = head;
    void loadRef.current({ limit: Math.min(Math.max(loaded.current, PAGE), 1000) });
  }, [head]);

  // The panel stays mounted behind the diff, but `display: none` forgets the scroll offset.
  useLayoutEffect(() => {
    if (active && listRef.current) listRef.current.scrollTop = scrollTop.current;
  }, [active]);

  const loadMore = () => {
    if (commits.length > 0 && !loading && hasMore) void load({ offset: commits.length });
  };
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    scrollTop.current = el.scrollTop;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) loadMore();
  };

  const rows = useMemo(() => {
    const now = new Date();
    const out: Row[] = [];
    let lastDay = '';
    for (const c of commits) {
      const d = new Date(c.date);
      const key = Number.isNaN(d.getTime()) ? '' : dayKey(d);
      if (key !== lastDay || out.length === 0) {
        lastDay = key;
        // Indexed, not just dated: a rebased commit can carry an older author date than its
        // neighbours and open a second group for the same day further down.
        out.push({ kind: 'day', key: `day:${key}:${out.length}`, label: key ? dayLabel(d, now) : '未知日期' });
      }
      out.push({ kind: 'commit', c });
    }
    return out;
  }, [commits]);

  const filtering = !!(filters.q || filters.author || filters.path || firstParent);
  const status = loading && commits.length === 0 ? '加载中…' : hasMore ? `已加载 ${commits.length} 条` : `共 ${commits.length} 条`;

  // The query goes in the sidebar, where a stacked form has room for labels and the two compare
  // buttons can say what they each do. It is rendered from here so it keeps sharing this
  // component's state; see the `sideSlot` note in the store.
  const controls = (
    <div className="side-form">
      <label className="field">
        搜索
        <input
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder="message 或 sha"
          spellCheck={false}
        />
      </label>
      <label className="field">
        作者
        <input value={draft.author} onChange={(e) => setDraft({ ...draft, author: e.target.value })} onKeyDown={onKeyDown} spellCheck={false} />
      </label>
      <label className="field">
        路径
        <input className="mono" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} onKeyDown={onKeyDown} spellCheck={false} />
      </label>
      <button
        className="toggle"
        aria-pressed={firstParent}
        onClick={() => setFirstParent(!firstParent)}
        title="只沿第一父提交走（git log --first-parent）：合并进来的分支折叠成它们的 merge commit"
      >
        只看主线
      </button>
      <div className="side-form-status muted small">{status}</div>

      <form
        className="side-group"
        title="分支自 base 分叉以来的全部改动，已提交和未提交都算（含未跟踪文件）"
        onSubmit={(e) => {
          e.preventDefault();
          compareBranch();
        }}
      >
        <div className="side-group-title">审阅整条分支</div>
        <label className="field">
          相对于
          <input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder={suggestedBase} spellCheck={false} />
        </label>
        {forkShown && <ForkNote state={forkShown} shortSha={(sha) => commits.find((c) => c.sha === sha)?.shortSha ?? sha.slice(0, 7)} onPick={pickCommit} />}
        <button type="submit">审阅自分叉以来的改动</button>
      </form>

      <form
        className="side-group"
        onSubmit={(e) => {
          e.preventDefault();
          compareRange();
        }}
      >
        <div className="side-group-title">对比两个 ref</div>
        <div className="field-row">
          <input value={rangeBase} onChange={(e) => setRangeBase(e.target.value)} placeholder="base" spellCheck={false} aria-label="range 的 base" />
          <span className="muted">..</span>
          <input value={rangeHead} onChange={(e) => setRangeHead(e.target.value)} placeholder="head" spellCheck={false} aria-label="range 的 head" />
        </div>
        <button type="submit" disabled={!rangeHead.trim()}>
          对比这两个 ref
        </button>
      </form>
    </div>
  );

  return (
    <div className="commits-panel" hidden={!active}>
      {active && sideSlot && createPortal(controls, sideSlot)}
      <div className="commits-list" ref={listRef} onScroll={onScroll}>
        {rows.map((row) => {
          if (row.kind === 'day') {
            return (
              <div key={row.key} className="commit-day">
                {row.label}
              </div>
            );
          }
          const c = row.c;
          const d = new Date(c.date);
          const time = Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const { text, pr } = splitSubject(c.subject);
          const isCurrent = !!currentSha && (c.sha === currentSha || c.sha.startsWith(currentSha));
          const isFork = c.sha === forkSha;
          return (
            <div
              key={c.sha}
              className={`commit-row ${isCurrent ? 'active' : ''} ${isFork ? 'fork' : ''}`}
              onClick={() => pickCommit(c.sha)}
              title={`${c.sha}\n${c.author} <${c.email}>\n${d.toLocaleString()}`}
            >
              <span className="mono sha">{c.shortSha}</span>
              <span className="subject">
                {text}
                {pr && <span className="pr">{pr}</span>}
              </span>
              <Refs refs={c.refs} head={c.head} />
              {isFork && (
                <span className="ref ref-fork" title={`与 ${effectiveBase} 的共同祖先（merge-base）`}>
                  分叉自 {effectiveBase}
                </span>
              )}
              {c.parents.length > 1 && <span className="badge">merge</span>}
              <span className="author">{c.author}</span>
              <span className="time">{time}</span>
            </div>
          );
        })}
        <div className="commits-foot muted">
          {loading && commits.length > 0 && '加载中…'}
          {!loading && hasMore && (
            <button className="link" onClick={loadMore}>
              加载更多
            </button>
          )}
          {!loading && !hasMore && commits.length > 0 && '已到最早的 commit'}
          {!loading && commits.length === 0 && (filtering ? '没有匹配的 commit' : '没有 commit')}
        </div>
      </div>
    </div>
  );
}
