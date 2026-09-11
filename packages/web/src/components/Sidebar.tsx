import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { FileTree } from './FileTree';

const MIN_WIDTH = 220;
const MAX_WIDTH = 520;

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
  const width = useStore((s) => s.sidebarWidth);
  const setWidth = useStore((s) => s.setSidebarWidth);
  const setSideSlot = useStore((s) => s.setSideSlot);
  const repo = useStore((s) => s.repo);
  const asideRef = useRef<HTMLElement>(null);

  const worktreeCount = repo ? repo.worktrees.length : 0;

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
        <select
          className="side-view-select"
          aria-label="切换视图"
          value={panel}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'diff' || value === 'commits' || value === 'worktrees') setPanel(value);
          }}
        >
          <option value="diff">变更</option>
          <option value="commits">提交</option>
          <option value="worktrees">Worktree{worktreeCount > 1 ? ` (${worktreeCount})` : ''}</option>
        </select>
      </nav>
      {panel === 'diff' ? <FileTree /> : <div className="side-slot" ref={setSideSlot} />}
      <div className="side-grip" onPointerDown={onGrip} role="separator" aria-label="调整侧栏宽度" />
    </aside>
  );
}
