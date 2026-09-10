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
 * Which repository is under review, and how the code is read. Nothing else: navigation belongs to
 * the sidebar, which is where each destination's own controls live, and what is under review is
 * picked where it is listed. The bar used to carry both and read as a pile of unrelated controls.
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
  const railOpen = useStore((s) => s.prefs.railOpen);
  const setRailOpen = useStore((s) => s.setRailOpen);
  const commentCount = useStore((s) => s.comments.length);
  const unexported = useStore((s) => s.comments.filter((c) => c.status === 'active').length);

  const target = useMemo(() => parseTargetKey(targetKey), [targetKey]);
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
          <select value={target.worktree ?? ''} title="Worktree" aria-label="Worktree" onChange={(e) => pickWorktree(e.target.value)}>
            <option value="">主仓库 ({repo.branch})</option>
            {otherWorktrees.map((w) => (
              <option key={w.path} value={w.path}>
                worktree: {w.path.split('/').filter(Boolean).pop()} ({w.branch ?? w.head.slice(0, 7)})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="topbar-right">
        <div className="seg" role="group" aria-label="diff 布局">
          <button className={viewMode === 'unified' ? 'active' : ''} aria-pressed={viewMode === 'unified'} onClick={() => setViewMode('unified')}>
            统一
          </button>
          <button className={viewMode === 'split' ? 'active' : ''} aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}>
            并排
          </button>
        </div>
        <NvimSelector />
        <button
          className="quiet"
          onClick={() => void refresh()}
          disabled={filesLoading}
          title={lastRefreshAt ? `上次刷新 ${shortTime(lastRefreshAt)}（r）` : '刷新 (r)'}
        >
          {filesLoading ? '刷新中…' : '刷新'}
        </button>
        {/* A button rather than a checkbox, and no separate timestamp: the label and the
            time cost ~140px in a bar that already wraps, and the refresh button's title
            still carries the last refresh. */}
        <button
          className="toggle quiet"
          aria-pressed={autoRefresh}
          aria-label="自动刷新"
          onClick={() => setAutoRefresh(!autoRefresh)}
          title={`仓库发生变化时自动刷新（当前${autoRefresh ? '开启' : '关闭'}）`}
        >
          自动
        </button>
        {/* The rail's switch. It carries the count because that is the reason to open it — and
            the unexported ones are the point of the whole tool, so they get the accent. */}
        <button
          className={`rail-switch ${railOpen ? 'active' : ''} ${unexported > 0 ? 'has-unexported' : ''}`}
          aria-pressed={railOpen}
          onClick={() => setRailOpen(!railOpen)}
          title={railOpen ? '收起右栏 (Esc)' : '展开评论、待办和 Issue'}
        >
          评论
          {commentCount > 0 && <span className="rail-switch-n">{commentCount}</span>}
        </button>
      </div>
    </header>
  );
}
