import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, Layers2, ListOrdered, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { useWorkflow, workflowAction } from '../workflow-store';
import { useWorkbench } from '../workbench-store';
import { useWorkbenchData } from '../workbench-data';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

export function WorkbenchNav({ connected = 0, behind = 0 }: { connected?: number; behind?: number }) {
  const { data, busy } = useWorkflow();
  const { preview, errors } = useWorkbenchData();
  const repo = useStore((state) => state.repo);
  const { view, taskId, navigationOpen, openView, openTask, setSheet } = useWorkbench();
  const [dragging, setDragging] = useState<string | null>(null);
  const tasks = data?.workflow?.changes.filter((task) => task.status !== 'archived' && task.developmentBranch === data.workflow?.developmentBranch) ?? [];
  const move = (id: string, before: string | null) => void workflowAction(() => api.moveChange(id, before));
  const connect = (id: string, connected: boolean) =>
    void workflowAction(async () => {
      const current = useWorkbenchData.getState().preview;
      if (!current) return;
      try {
        useWorkbenchData.setState({
          preview: await api.connectPreview(connected ? [...current.connectedIds, id] : current.connectedIds.filter((value) => value !== id)),
        });
      } finally {
        await useWorkbenchData.getState().refresh();
      }
    });
  return (
    <>
      {navigationOpen && (
        <button type="button" className="wb-nav-scrim" aria-label="关闭工作导航" onClick={() => useWorkbench.setState({ navigationOpen: false })} />
      )}
      <nav className={`wb-navigation${navigationOpen ? ' is-open' : ''}`} aria-label="工作导航">
        <div className="wb-brand">
          <span className="wb-brand-mark">W</span>
          <strong>Warden</strong>
          <span className="spacer" />
          <Button
            className="wb-mobile-only"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭工作导航"
            onClick={() => useWorkbench.setState({ navigationOpen: false })}
          >
            <X size={16} />
          </Button>
        </div>
        <button className="wb-context" type="button" onClick={() => setSheet('settings')} title="主开发分支设置">
          <span>
            <GitBranch size={15} />
            <strong>{data?.workflow?.developmentBranch ?? '选择主开发分支'}</strong>
          </span>
          <small title={repo?.commonRoot}>{repo?.commonRoot ?? repo?.root}</small>
        </button>
        <div className="wb-nav-links">
          <button
            type="button"
            className={view === 'preview' ? 'is-active' : ''}
            aria-current={view === 'preview' ? 'page' : undefined}
            onClick={() => openView('preview')}
          >
            <Layers2 size={17} />
            运行预览{connected > 0 && <span className="wb-count">{connected}</span>}
          </button>
          <button
            type="button"
            className={view === 'history' ? 'is-active' : ''}
            aria-current={view === 'history' ? 'page' : undefined}
            onClick={() => openView('history')}
          >
            <GitCommitHorizontal size={17} />
            提交历史
          </button>
        </div>
        <div className="wb-plan-heading">
          <ListOrdered size={14} />
          <span>工作区</span>
          <span className="spacer" />
          <Button variant="ghost" size="icon-sm" title="新增任务" aria-label="新增任务" onClick={() => setSheet('plan')}>
            <Plus size={17} />
          </Button>
        </div>
        <ol className="wb-plan-list" aria-label="工作区" title="拖动或使用箭头调整计划顺序">
          {tasks.map((task, index) => (
            <li
              key={task.id}
              className={view === 'task' && taskId === task.id ? 'is-active' : ''}
              draggable={!busy}
              onDragStart={() => setDragging(task.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging && dragging !== task.id) move(dragging, task.id);
                setDragging(null);
              }}
            >
              <button
                type="button"
                className="wb-plan-link"
                aria-current={view === 'task' && taskId === task.id ? 'page' : undefined}
                onClick={() => openTask(task.id)}
              >
                <span className="wb-plan-number">{index + 1}</span>
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.integration?.prepared && task.status === 'integrating' ? '待提交' : task.worktree ? task.branch : '未创建工作区'}</small>
                </span>
              </button>
              {task.worktree && task.status !== 'accepted' && (
                <Switch
                  className="wb-plan-connection"
                  aria-label={`连接 ${task.title}`}
                  title={preview?.connectedIds.includes(task.id) ? '断开运行预览' : '连接到运行预览，不创建提交'}
                  checked={preview?.connectedIds.includes(task.id) ?? false}
                  disabled={busy || !preview || preview.status === 'paused' || !!errors.preview}
                  onCheckedChange={(connected) => connect(task.id, connected)}
                />
              )}
              <div className="wb-plan-order" aria-label="调整计划顺序">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`上移计划：${task.title}`}
                  title="上移计划"
                  disabled={busy || index === 0}
                  onClick={() => move(task.id, tasks[index - 1]!.id)}
                >
                  <ArrowUp size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`下移计划：${task.title}`}
                  title="下移计划"
                  disabled={busy || index === tasks.length - 1}
                  onClick={() => move(task.id, tasks[index + 2]?.id ?? null)}
                >
                  <ArrowDown size={13} />
                </Button>
              </div>
            </li>
          ))}
          {tasks.length === 0 && <li className="wb-nav-empty">暂无任务</li>}
        </ol>
        <div className="wb-nav-links wb-nav-bottom">
          <button type="button" onClick={() => setSheet('sync')}>
            <RefreshCw size={16} />
            同步工作区{behind > 0 && <span className="wb-count">{behind}</span>}
          </button>
          <button type="button" onClick={() => setSheet('settings')}>
            <Settings2 size={16} />
            设置
          </button>
        </div>
      </nav>
    </>
  );
}
