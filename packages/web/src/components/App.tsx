import { useEffect } from 'react';
import { Menu, X } from 'lucide-react';
import type { ChangeEvent } from '@warden/shared';
import { api } from '../api';
import { useStore } from '../store';
import { useWorkflow } from '../workflow-store';
import { useWorkbench } from '../workbench-store';
import { useWorkbenchData } from '../workbench-data';
import { dirName } from '../lib/paths';
import { Button } from './ui/button';
import { WorkbenchNav } from './WorkbenchNav';
import { TaskWorkspace } from './TaskWorkspace';
import { PreviewPage } from './PreviewPage';
import { HistoryPage } from './HistoryPage';
import { RebaseSheet } from './RebaseSheet';
import { WorkbenchSheets } from './WorkbenchSheets';
import { Toast } from './Toast';

export function App() {
  const repo = useStore((state) => state.repo);
  const root = useStore((state) => state.root);
  const initError = useStore((state) => state.initError);
  const { data, error, actionError } = useWorkflow();
  const { view, taskId } = useWorkbench();
  const { preview, checks } = useWorkbenchData();
  const task = data?.workflow?.changes.find((row) => row.id === taskId && row.developmentBranch === data.workflow?.developmentBranch);

  useEffect(() => {
    void useStore.getState().init();
    void useWorkflow.getState().refresh();
    void useWorkbenchData.getState().refresh();
    useStore.setState({ reviewReadOnly: true });
    const interval = window.setInterval(() => {
      void useWorkflow.getState().refresh();
      void useWorkbenchData.getState().refresh();
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (data?.workflow && view === 'task' && taskId && !task) useWorkbench.getState().openView('preview');
    void useWorkbenchData.getState().refresh();
  }, [data?.workflow?.developmentBranch]);

  useEffect(() => {
    if (repo?.root) document.title = `${dirName(repo.root)} · Warden`;
  }, [repo?.root]);

  useEffect(() => {
    if (!repo) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void useWorkflow.getState().refresh();
        void useWorkbenchData.getState().refresh();
        void useStore.getState().refresh();
      }, 200);
    };
    const sources = [...new Set([repo.commonRoot, repo.root, root].filter(Boolean))].map((path) => {
      const source = api.events(path);
      source.addEventListener('changed', (event) => {
        try {
          useStore.getState().onRepoChanged(JSON.parse((event as MessageEvent).data) as ChangeEvent);
        } catch {
          /* Ignore malformed event frames. */
        }
        refresh();
      });
      source.addEventListener('state', refresh);
      source.onopen = refresh;
      return source;
    });
    return () => {
      clearTimeout(timer);
      for (const source of sources) source.close();
    };
  }, [repo?.commonRoot, repo?.root, root]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => {
      if (media.matches) useStore.getState().setViewMode('unified');
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable) return;
      if (useWorkbench.getState().sheet) return;
      const store = useStore.getState();
      if (event.key === 'r') {
        event.preventDefault();
        void store.refresh();
        void useWorkflow.getState().refresh();
        void useWorkbenchData.getState().refresh();
      }
      if (useWorkbench.getState().view !== 'task') return;
      if (event.key === 'j' || event.key === 'k') {
        const index = store.files.findIndex((file) => file.path === store.activeFile);
        const next = store.files[Math.max(0, Math.min(store.files.length - 1, index + (event.key === 'j' ? 1 : -1)))];
        if (next) {
          event.preventDefault();
          void store.openFile(next.path);
        }
      }
      if (event.key === 'Escape') {
        if (store.editor) store.setEditor(null);
        else if (store.focusedCommentId) void store.focusComment(null);
        else store.setRailOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (initError)
    return (
      <div className="fatal">
        <h1>Warden</h1>
        <p>无法连接服务端：{initError}</p>
        <Button variant="outline" onClick={() => void useStore.getState().init()}>
          重试
        </Button>
      </div>
    );
  if (!repo) return <div className="loading-screen">加载仓库…</div>;
  return (
    <div className="wb-app">
      <WorkbenchNav connected={preview?.connectedIds.length ?? 0} behind={checks.filter((check) => check.status !== 'current').length} />
      <div className="wb-content">
        <div className="wb-mobile-header">
          <Button variant="ghost" size="sm" onClick={() => useWorkbench.setState({ navigationOpen: true })}>
            <Menu size={17} />
            导航
          </Button>
          <span>{data?.workflow?.developmentBranch ?? 'Warden'}</span>
        </div>
        {(actionError || error) && (
          <div className="wb-global-error" role="alert">
            <span>{actionError ?? error}</span>
            <Button variant="ghost" size="icon-xs" aria-label="关闭操作提示" onClick={() => useWorkflow.setState({ actionError: null, error: null })}>
              <X size={14} />
            </Button>
          </div>
        )}
        <main className="wb-main">
          <PreviewPage active={view === 'preview'} />
          <HistoryPage active={view === 'history'} />
          {task && <TaskWorkspace key={task.id} task={task} active={view === 'task'} />}
          {view === 'task' && !task && <div className="wb-empty-inline">请选择任务</div>}
        </main>
      </div>
      <WorkbenchSheets />
      <RebaseSheet />
      <Toast />
    </div>
  );
}
