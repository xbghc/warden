import { useMemo, useState } from 'react';
import { commentScopeKey, formatTargetKey, isLocalTarget, parseTargetKey, targetLabel, type Target } from '@warden/shared';
import { branchOf, useStore } from '../store';
import { NvimSelector } from './NvimSelector';

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type Kind = Target['kind'];

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
  const todos = useStore((s) => s.todos);
  const root = useStore((s) => s.root);
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
  }

  const apply = (next: Partial<{ kind: Kind; worktree: string; sha: string; base: string; head: string }> = {}) => {
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

  const branch = branchOf(repo, root);
  const openIssues = issues.filter((i) => i.status === 'open').length;
  const openTodos = todos.filter((t) => t.branch === branch && t.status === 'open').length;
  const otherWorktrees = repo.worktrees.filter((w) => w.path !== repo.root);

  return (
    <header className="topbar">
      <div className="brand" title={repo.root}>
        <span className="logo">warden</span>
        <span className="repo-name">{repo.root.split('/').filter(Boolean).pop()}</span>
        <span className="branch">{repo.branch}</span>
      </div>

      <div className="target-switcher">
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
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as Kind;
            setKind(k);
            if (k === 'working' || k === 'staged' || k === 'all') apply({ kind: k });
          }}
        >
          <option value="working">工作区未提交</option>
          <option value="staged">已 staged</option>
          <option value="all">工作区全部 (vs HEAD)</option>
          <option value="commit">单个 commit</option>
          <option value="range">两个 ref 对比</option>
        </select>
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
            <span>..</span>
            <input value={head} onChange={(e) => setHead(e.target.value)} placeholder="head" spellCheck={false} />
            <button type="submit">对比</button>
          </form>
        )}
        <span className="target-label" title={targetKey}>
          {targetLabel(target)}
        </span>
      </div>

      <div className="spacer" />

      <div className="actions">
        <button className={panel === 'commits' ? 'active' : ''} onClick={() => setPanel(panel === 'commits' ? 'diff' : 'commits')} title="历史 commit">
          Commits
        </button>
        <button className={panel === 'issues' ? 'active' : ''} onClick={() => setPanel(panel === 'issues' ? 'diff' : 'issues')} title="本地 Issue">
          Issues{openIssues ? ` (${openIssues})` : ''}
        </button>
        <button className={panel === 'todos' ? 'active' : ''} onClick={() => setPanel(panel === 'todos' ? 'diff' : 'todos')} title={`${branch} 分支的 Todo`}>
          Todos{openTodos ? ` (${openTodos})` : ''}
        </button>
        <div className="seg">
          <button className={viewMode === 'unified' ? 'active' : ''} onClick={() => setViewMode('unified')}>
            Unified
          </button>
          <button className={viewMode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')}>
            Split
          </button>
        </div>
        <NvimSelector />
        <label className="check" title="仓库发生变化时自动刷新">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          自动刷新
        </label>
        <button onClick={() => void refresh()} disabled={filesLoading} title={lastRefreshAt ? `上次刷新 ${shortTime(lastRefreshAt)}（r）` : '刷新 (r)'}>
          {filesLoading ? '刷新中…' : '刷新'}
        </button>
        {lastRefreshAt && <span className="muted small last-refresh">{shortTime(lastRefreshAt)}</span>}
      </div>
    </header>
  );
}
