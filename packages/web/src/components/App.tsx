import { useEffect, useState } from 'react';
import type { ChangeEvent, TargetKey } from '@warden/shared';
import { formatTargetKey, isLocalTarget, tryParseTargetKey } from '@warden/shared';
import { useStore } from '../store';
import { api } from '../api';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { DiffPanel } from './DiffPanel';
import { CommitsPanel } from './CommitsPanel';
import { WorktreesPanel } from './WorktreesPanel';
import { Rail } from './Rail';
import { Toast } from './Toast';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'checkbox';
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** The sidebar order j/k walks: the Unstaged block, then the Staged one. */
function navigableFiles(s: ReturnType<typeof useStore.getState>): { view: TargetKey; path: string }[] {
  const target = tryParseTargetKey(s.targetKey);
  if (!target || !isLocalTarget(target)) return s.files.map((f) => ({ view: s.targetKey, path: f.path }));
  const wt = target.worktree ? { worktree: target.worktree } : {};
  const working = formatTargetKey({ kind: 'working', ...wt });
  const staged = formatTargetKey({ kind: 'staged', ...wt });
  return [...s.unstaged.map((f) => ({ view: working, path: f.path })), ...s.staged.map((f) => ({ view: staged, path: f.path }))];
}

export function App() {
  const init = useStore((s) => s.init);
  const initError = useStore((s) => s.initError);
  const repo = useStore((s) => s.repo);
  const panel = useStore((s) => s.panel);
  const root = useStore((s) => s.root);

  // Once opened, the commit list stays mounted behind the diff: picking a commit switches to its
  // diff, and coming back should land on the same page and scroll position, not at the top.
  const [commitsOpened, setCommitsOpened] = useState(panel === 'commits');
  if (panel === 'commits' && !commitsOpened) setCommitsOpened(true);

  useEffect(() => {
    void init();
  }, [init]);

  // Live repository changes. Reconnects are handled by EventSource itself; a successful reconnect
  // catches up on whatever was missed while the stream was down.
  useEffect(() => {
    if (!root) return;
    const source = api.events(root);
    let wasDown = false;
    const onChanged = (ev: Event) => {
      try {
        useStore.getState().onRepoChanged(JSON.parse((ev as MessageEvent).data) as ChangeEvent);
      } catch {
        /* a malformed frame is not worth surfacing */
      }
    };
    source.addEventListener('changed', onChanged);
    source.onopen = () => {
      if (!wasDown) return;
      wasDown = false;
      void useStore.getState().refresh();
    };
    source.onerror = () => {
      wasDown = true;
    };
    return () => {
      source.removeEventListener('changed', onChanged);
      source.close();
    };
  }, [root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const s = useStore.getState();
      if (e.key === 'r') {
        e.preventDefault();
        void s.refresh();
      } else if (e.key === 's') {
        if (s.panel !== 'diff' || !s.stageSel || s.staging) return;
        e.preventDefault();
        void s.stageSelection();
      } else if (e.key === 'j' || e.key === 'k') {
        if (s.panel !== 'diff') return;
        const seq = navigableFiles(s);
        if (seq.length === 0) return;
        e.preventDefault();
        let idx = seq.findIndex((x) => x.path === s.activeFile && x.view === s.targetKey);
        if (idx < 0) idx = seq.findIndex((x) => x.path === s.activeFile);
        const next = e.key === 'j' ? Math.min(seq.length - 1, idx + 1) : Math.max(0, idx - 1);
        const item = seq[next];
        if (!item) return;
        void (async () => {
          // Crossing from one block to the other changes the view along with the file.
          if (item.view !== s.targetKey) await s.switchView(item.view, item.path);
          await s.openFile(item.path);
        })();
      } else if (e.key === 'Escape') {
        if (s.stageSel) s.setStageSel(null);
        else if (s.reattaching) s.setReattaching(null);
        else if (s.editor) s.setEditor(null);
        else if (s.focusedCommentId) void s.focusComment(null);
        else if (s.prefs.railOpen) s.setRailOpen(false);
        else if (s.panel !== 'diff') s.setPanel('diff');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (initError) {
    return (
      <div className="fatal">
        <h1>warden</h1>
        <p>无法连接服务端：{initError}</p>
        <button onClick={() => void init()}>重试</button>
      </div>
    );
  }
  if (!repo) return <div className="loading-screen">加载中…</div>;

  return (
    <div className="app">
      <TopBar />
      <div className="body">
        <Sidebar />
        <main className="main">
          {commitsOpened && <CommitsPanel active={panel === 'commits'} />}
          {panel === 'worktrees' && <WorktreesPanel />}
          {panel !== 'commits' && panel !== 'worktrees' && <DiffPanel />}
        </main>
        <Rail />
      </div>
      <Toast />
    </div>
  );
}
