import { useCallback, useEffect, useMemo, useRef } from 'react';
import { formatTargetKey, isLocalTarget, type Target, tryParseTargetKey } from '@warden/shared';
import { useStore } from '../store';
import { FileTree } from './FileTree';

const MIN_WIDTH = 220;
const MAX_WIDTH = 520;

/** A full sha is cut to git's short form; a ref someone typed is shown as typed. */
const shortRef = (ref: string) => (/^[0-9a-f]{40,}$/.test(ref) ? ref.slice(0, 7) : ref);

/** How the view picker names a commit, range, branch or checkpoint target. The worktree is the top bar's to name. */
function historyLabel(t: Target): string {
  if (t.kind === 'commit') return `提交 ${shortRef(t.sha)}`;
  if (t.kind === 'range') return `${shortRef(t.base)}..${shortRef(t.head)}`;
  if (t.kind === 'base') return `分支 vs ${t.ref}`;
  if (t.kind === 'checkpoint') return `检查点 #${t.id}`;
  return '工作区';
}

/**
 * The left column is the input side of whatever the middle is showing: the file list for a diff,
 * the query for the commit list, the new-worktree form for the worktree list. That makes it the
 * only navigation in the app, which is why the top bar carries none — a bar mixing destinations
 * with view controls is the reason the old one read as a pile.
 *
 * The commit and worktree panels fill the slot below through a portal, from the middle.
 */
export function Sidebar() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);
  const width = useStore((s) => s.sidebarWidth);
  const setWidth = useStore((s) => s.setSidebarWidth);
  const setSideSlot = useStore((s) => s.setSideSlot);
  const repo = useStore((s) => s.repo);
  const asideRef = useRef<HTMLElement>(null);

  const worktreeCount = repo ? repo.worktrees.length : 0;
  const target = useMemo(() => tryParseTargetKey(targetKey), [targetKey]);
  // A key that does not parse is listed under its raw text rather than passed off as the working tree.
  const history = !target || !isLocalTarget(target);
  const value = panel === 'diff' ? (history ? 'target' : 'working') : panel;

  const pick = (next: string) => {
    if (next === 'working' && history) void setTarget(formatTargetKey({ kind: 'working', ...(target?.worktree ? { worktree: target.worktree } : {}) }));
    else if (next === 'working' || next === 'target') setPanel('diff');
    else if (next === 'commits' || next === 'worktrees') setPanel(next);
  };

  // Dragging the edge rather than the CSS `resize` corner: the corner grip only appears at the
  // bottom of the column, nowhere near the border it moves.
  const onGrip = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const left = asideRef.current?.getBoundingClientRect().left ?? 0;
      const move = (ev: PointerEvent) => setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX - left)));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
      };
      document.body.classList.add('resizing');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [setWidth],
  );

  useEffect(() => () => setSideSlot(null), [setSideSlot]);

  return (
    <aside className="sidebar" style={{ width }} ref={asideRef}>
      <nav className="side-nav" aria-label="导航">
        {/* A commit, range or branch under review gets an entry of its own, and it is what the
            picker reads while its files are in front. With one entry for every diff, a click in
            the commit list left the picker saying 变更 over that commit's files, and the name in
            small print below lost to it. 工作区 is always listed, so it is also the way back. */}
        <select
          className="side-view-select"
          aria-label="切换视图"
          value={value}
          title={value === 'target' ? targetKey : undefined}
          onChange={(event) => pick(event.target.value)}
        >
          <option value="working">工作区</option>
          {history && <option value="target">{target ? historyLabel(target) : targetKey}</option>}
          <option value="commits">提交历史</option>
          <option value="worktrees">Worktree{worktreeCount > 1 ? ` (${worktreeCount})` : ''}</option>
        </select>
      </nav>
      {panel === 'diff' ? <FileTree /> : <div className="side-slot" ref={setSideSlot} />}
      <div className="side-grip" onPointerDown={onGrip} role="separator" aria-label="调整侧栏宽度" />
    </aside>
  );
}
