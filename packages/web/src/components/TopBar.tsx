import { useMemo, useState } from 'react';
import { commentScopeKey, formatTargetKey, isLocalTarget, parseTargetKey, targetLabel, type Target } from '@warden/shared';
import { useStore } from '../store';
import { NvimSelector } from './NvimSelector';

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type Kind = Target['kind'];

/** The six ways to pick what is under review, in the order they sit in the bar. */
const KINDS: { kind: Kind; label: string; title: string }[] = [
  { kind: 'working', label: 'Unstaged', title: '工作区未提交的改动（含未跟踪文件）' },
  { kind: 'staged', label: 'Staged', title: '已暂存的改动' },
  { kind: 'all', label: 'All', title: '工作区全部改动（对比 HEAD）' },
  { kind: 'base', label: 'Branch', title: '分支自 base 分叉以来的全部改动，已提交和未提交都算（含未跟踪文件）' },
  { kind: 'commit', label: 'Commit', title: '查看单个 commit' },
  { kind: 'range', label: 'Range', title: '对比两个 ref' },
];

/** A pin beside two lines of text — the comment marker, which is also the favicon. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 16 16" aria-hidden="true">
      <rect width="16" height="16" rx="3" fill="#5b47d9" />
      <rect x="3.5" y="4" width="2" height="8" rx="1" fill="#fff" />
      <path d="M8 5.5h4.5M8 10.5h3" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar() {
  const repo = useStore((s) => s.repo)!;
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);
  const switchView = useStore((s) => s.switchView);
  const refresh = useStore((s) => s.refresh);
  const filesLoading = useStore((s) => s.filesLoading);
  const autoRefresh = useStore((s) => s.prefs.autoRefresh);
  const setAutoRefresh = useStore((s) => s.setAutoRefresh);
  const lastRefreshAt = useStore((s) => s.lastRefreshAt);
  const viewMode = useStore((s) => s.prefs.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const issues = useStore((s) => s.issues);

  const target = useMemo(() => parseTargetKey(targetKey), [targetKey]);
  const [kind, setKind] = useState<Kind>(target.kind);
  const [worktree, setWorktree] = useState<string>(target.worktree ?? '');
  const [sha, setSha] = useState(target.kind === 'commit' ? target.sha : '');
  const [base, setBase] = useState(target.kind === 'range' ? target.base : '@');
  const [head, setHead] = useState(target.kind === 'range' ? target.head : '');
  const [baseRef, setBaseRef] = useState(target.kind === 'base' ? target.ref : '');

  // Where the branch in worktree `wt` most likely forked off: the main worktree's branch when
  // `wt` is a sibling of it, otherwise main / master if the repository has one.
  const mainWorktree = repo.worktrees.find((w) => w.isMain);
  const suggestBase = (wt: string): string =>
    ((wt || repo.root) !== mainWorktree?.path && mainWorktree?.branch) || repo.defaultBase || 'main';

  // Keep the form in sync when the target changes from elsewhere (commit list, issue jump).
  const [syncedKey, setSyncedKey] = useState(targetKey);
  if (syncedKey !== targetKey) {
    setSyncedKey(targetKey);
    setKind(target.kind);
    setWorktree(target.worktree ?? '');
    if (target.kind === 'commit') setSha(target.sha);
    if (target.kind === 'range') {
      setBase(target.base);
      setHead(target.head);
    }
    if (target.kind === 'base') setBaseRef(target.ref);
  }

  const apply = (next: Partial<{ kind: Kind; worktree: string; sha: string; base: string; head: string; ref: string }> = {}) => {
    const k = next.kind ?? kind;
    const wt = next.worktree ?? worktree;
    const wtField = wt ? { worktree: wt } : {};
    let t: Target;
    if (k === 'commit') {
      const v = (next.sha ?? sha).trim();
      if (!v) return;
      t = { kind: 'commit', sha: v, ...wtField };
    } else if (k === 'range') {
      const b = (next.base ?? base).trim() || '@';
      const h = (next.head ?? head).trim();
      if (!h) return;
      t = { kind: 'range', base: b, head: h, ...wtField };
    } else if (k === 'base') {
      // Has a sensible default, unlike a commit or a range, so an empty field is not a no-op.
      t = { kind: 'base', ref: (next.ref ?? baseRef).trim() || suggestBase(wt), ...wtField };
    } else {
      t = { kind: k, ...wtField };
    }
    const key = formatTargetKey(t);
    if (key === targetKey) return;
    // Moving between the three local views keeps the comments, the draft and the selection;
    // anything else (another worktree, a commit, a range) is a different review altogether.
    if (isLocalTarget(t) && commentScopeKey(key) === commentScopeKey(targetKey)) void switchView(key);
    else void setTarget(key);
  };

  // The segmented control already names the three local views; the label only adds
  // something for a commit, a range, or a worktree (which it prefixes with the name).
  const showTargetLabel = target.kind === 'commit' || target.kind === 'range' || target.kind === 'base' || !!target.worktree;
  const openIssues = issues.filter((i) => i.status === 'open').length;
  const otherWorktrees = repo.worktrees.filter((w) => w.path !== repo.root);

  return (
    <header className="topbar">
      <div className="brand" title={repo.root}>
        <Mark />
        <span className="wordmark">warden</span>
      </div>
      <div className="scope">
        <span className="repo-name">{repo.root.split('/').filter(Boolean).pop()}</span>
        <span className="branch">{repo.branch}</span>
        {otherWorktrees.length > 0 && (
          <select
            value={worktree}
            title="Worktree"
            onChange={(e) => {
              setWorktree(e.target.value);
              apply({ worktree: e.target.value });
            }}
          >
            <option value="">主仓库 ({repo.branch})</option>
            {otherWorktrees.map((w) => (
              <option key={w.path} value={w.path}>
                worktree: {w.path.split('/').filter(Boolean).pop()} ({w.branch ?? w.head.slice(0, 7)})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="target">
        <div className="seg" role="group" aria-label="审查目标">
          {KINDS.map(({ kind: k, label, title }) => (
            <button
              key={k}
              className={kind === k ? 'active' : ''}
              aria-pressed={kind === k}
              title={title}
              onClick={() => {
                setKind(k);
                // The local views and the branch view can show right away; a commit or a
                // range still needs a ref typed in first.
                if (k === 'working' || k === 'staged' || k === 'all' || k === 'base') apply({ kind: k });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {kind === 'commit' && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            <input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="sha / ref" spellCheck={false} />
            <button type="submit">查看</button>
          </form>
        )}
        {kind === 'range' && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="base (@ = HEAD)" spellCheck={false} />
            <span className="muted">..</span>
            <input value={head} onChange={(e) => setHead(e.target.value)} placeholder="head" spellCheck={false} />
            <button type="submit">对比</button>
          </form>
        )}
        {kind === 'base' && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            <span className="muted">vs</span>
            <input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder={suggestBase(worktree)} spellCheck={false} />
            <button type="submit">对比</button>
          </form>
        )}
        {showTargetLabel && (
          <span className="target-label" title={targetKey}>
            {targetLabel(target)}
          </span>
        )}
      </div>

      {/* One block, so a narrow window wraps tabs and tools together and keeps them on the right. */}
      <div className="topbar-right">
        <nav className="tabs" aria-label="面板">
          <button className={`tab ${panel === 'commits' ? 'active' : ''}`} onClick={() => setPanel(panel === 'commits' ? 'diff' : 'commits')} title="历史 commit">
            Commits
          </button>
          <button className={`tab ${panel === 'issues' ? 'active' : ''}`} onClick={() => setPanel(panel === 'issues' ? 'diff' : 'issues')} title="本地 Issue">
            Issues
            {openIssues > 0 && <span className="tab-count">{openIssues}</span>}
          </button>
        </nav>
        <div className="tools">
        <div className="seg" role="group" aria-label="diff 布局">
          <button className={viewMode === 'unified' ? 'active' : ''} aria-pressed={viewMode === 'unified'} onClick={() => setViewMode('unified')}>
            Unified
          </button>
          <button className={viewMode === 'split' ? 'active' : ''} aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}>
            Split
          </button>
        </div>
        <NvimSelector />
        <button onClick={() => void refresh()} disabled={filesLoading} title={lastRefreshAt ? `上次刷新 ${shortTime(lastRefreshAt)}（r）` : '刷新 (r)'}>
          {filesLoading ? '刷新中…' : '刷新'}
        </button>
        {/* A button rather than a checkbox, and no separate timestamp: the label and the
            time cost ~140px in a bar that already wraps, and the refresh button's title
            still carries the last refresh. */}
        <button
          className="toggle"
          aria-pressed={autoRefresh}
          aria-label="自动刷新"
          onClick={() => setAutoRefresh(!autoRefresh)}
          title={`仓库发生变化时自动刷新（当前${autoRefresh ? '开启' : '关闭'}）`}
        >
          自动
        </button>
        </div>
      </div>
    </header>
  );
}
