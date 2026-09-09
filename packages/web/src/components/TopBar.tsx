import { useMemo } from 'react';
import { formatTargetKey, parseTargetKey } from '@warden/shared';
import { useStore } from '../store';
import { NvimSelector } from './NvimSelector';

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

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

/**
 * Brand, scope and tools — not the target. What is under review is picked where it is listed:
 * the sidebar's two blocks are the working tree, the Commits panel holds commits, ranges and
 * the branch view, and the sidebar names whichever of those is up and offers the way back.
 */
export function TopBar() {
  const repo = useStore((s) => s.repo)!;
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);
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
  const openIssues = issues.filter((i) => i.status === 'open').length;
  const otherWorktrees = repo.worktrees.filter((w) => w.path !== repo.root);

  // Another worktree is a different review altogether, so this is a full target change; the kind
  // of target carries over (the same commit exists in every worktree, a branch view keeps its base).
  const pickWorktree = (wt: string) => {
    const key = formatTargetKey({ ...target, worktree: wt || undefined });
    if (key !== targetKey) void setTarget(key);
  };

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
          <select value={target.worktree ?? ''} title="Worktree" onChange={(e) => pickWorktree(e.target.value)}>
            <option value="">主仓库 ({repo.branch})</option>
            {otherWorktrees.map((w) => (
              <option key={w.path} value={w.path}>
                worktree: {w.path.split('/').filter(Boolean).pop()} ({w.branch ?? w.head.slice(0, 7)})
              </option>
            ))}
          </select>
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
          <button className={`tab ${panel === 'worktrees' ? 'active' : ''}`} onClick={() => setPanel(panel === 'worktrees' ? 'diff' : 'worktrees')} title="新建、切换和删除 worktree">
            Worktrees
            {otherWorktrees.length > 0 && <span className="tab-count">{otherWorktrees.length}</span>}
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
