import { useEffect } from 'react';
import { useStore } from '../store';
import { TopBar } from './TopBar';
import { FileTree } from './FileTree';
import { DiffPanel } from './DiffPanel';
import { CommitsPanel } from './CommitsPanel';
import { IssuesDrawer } from './IssuesDrawer';
import { Toast } from './Toast';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'checkbox';
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function App() {
  const init = useStore((s) => s.init);
  const initError = useStore((s) => s.initError);
  const repo = useStore((s) => s.repo);
  const panel = useStore((s) => s.panel);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const s = useStore.getState();
      if (e.key === 'r') {
        e.preventDefault();
        void s.refresh();
      } else if (e.key === 'j' || e.key === 'k') {
        if (s.panel !== 'diff' || s.files.length === 0) return;
        e.preventDefault();
        const idx = s.files.findIndex((f) => f.path === s.activeFile);
        const next = e.key === 'j' ? Math.min(s.files.length - 1, idx + 1) : Math.max(0, idx - 1);
        const f = s.files[next];
        if (f) void s.openFile(f.path);
      } else if (e.key === 'Escape') {
        if (s.reattaching) s.setReattaching(null);
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
        <FileTree />
        <main className="main">{panel === 'commits' ? <CommitsPanel /> : <DiffPanel />}</main>
        {panel === 'issues' && <IssuesDrawer />}
      </div>
      <Toast />
    </div>
  );
}
