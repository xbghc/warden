import { useLayoutEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  History,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Settings,
  Settings2,
  Unplug,
  RefreshCw,
  TriangleAlert,
  ScrollText,
} from 'lucide-react';
import type { FileEntry, WorkbenchAction, WorkbenchModel, WorkspaceRow } from '@warden/shared';
import { IconButton } from './components/ui/icon-button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './components/ui/dropdown-menu';
import { Task, taskDraftKey } from './task';
import type { ViewState } from './task';

type Props = { model: WorkbenchModel; send(action: WorkbenchAction): void; state: ViewState };
const dragType = 'application/vnd.warden.task';
const fileTitle = (file: FileEntry) =>
  [file.path, file.oldMode !== file.newMode ? `文件模式 ${file.oldMode ?? '无'} → ${file.newMode ?? '无'}` : ''].filter(Boolean).join('\n');

export function Workspaces({ model, send, state }: Props) {
  const rows = model.workspaces ?? [];
  useLayoutEffect(() => {
    const key = `workspaces:${model.repository}:scroll`;
    window.scrollTo(0, state.read(key, 0));
    const save = () => state.save(key, window.scrollY);
    window.addEventListener('scroll', save);
    return () => window.removeEventListener('scroll', save);
  }, [model.repository]);
  const drop = (event: React.DragEvent, before: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const value = JSON.parse(event.dataTransfer.getData(dragType));
      if (value.session === model.session && rows.some((row) => row.task.id === value.taskId) && value.taskId !== before)
        send({ type: 'task.move', taskId: value.taskId, before });
    } catch {
      /* Foreign drags never become task mutations. */
    }
  };
  return (
    <>
      <nav className="workspace-navigation" aria-label="Warden 导航">
        <button type="button" onClick={() => send({ type: 'workspaces.show', surface: 'preview' })}>
          <Layers aria-hidden="true" />
          预览
        </button>
        <button type="button" onClick={() => send({ type: 'workspaces.show', surface: 'history' })}>
          <History aria-hidden="true" />
          提交历史
        </button>
        <IconButton label="设置" onClick={() => send({ type: 'workspaces.show', surface: 'settings' })}>
          <Settings aria-hidden="true" />
        </IconButton>
      </nav>
      {model.creating && <Task key={taskDraftKey(model)} model={model} send={send} state={state} />}
      <div
        role="list"
        aria-label="任务工作区"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(dragType)) event.preventDefault();
        }}
        onDrop={(event) => drop(event, null)}
      >
        {rows.map((row, index) => (
          <Workspace
            key={row.task.id}
            row={row}
            model={model}
            send={send}
            state={state}
            onDrop={(event) => drop(event, row.task.id)}
            onReorder={(direction) => {
              if (direction === -1 && index > 0) send({ type: 'task.move', taskId: row.task.id, before: rows[index - 1]!.task.id });
              if (direction === 1 && index < rows.length - 1) send({ type: 'task.move', taskId: row.task.id, before: rows[index + 2]?.task.id ?? null });
            }}
          />
        ))}
        {!rows.length && !model.creating && (
          <div className="workspace-empty">
            <span className="muted">暂无任务</span>
            <IconButton label="新增任务" onClick={() => send({ type: 'workspaces.create' })}>
              <Plus aria-hidden="true" />
            </IconButton>
          </div>
        )}
        <div className="workspace-drop-end" aria-hidden="true" />
      </div>
    </>
  );
}

function Workspace({
  row,
  model,
  send,
  state,
  onDrop,
  onReorder,
}: Props & { row: WorkspaceRow; onDrop(event: React.DragEvent): void; onReorder(direction: -1 | 1): void }) {
  const { task } = row;
  const taskId = task.id;
  const connected = !!model.preview?.connectedIds.includes(taskId);
  const sync = model.checks?.checks.find((check) => check.changeId === taskId);
  const selected = !model.creating && model.task?.id === taskId;
  const busy = !!model.busy;
  const commitLabel =
    task.integration && !task.integration.prepared
      ? '恢复提交准备'
      : row.review?.preparation?.canRecord
        ? '记录已审阅的提交'
        : `提交到 ${task.developmentBranch}`;
  const errors = model.errors.filter((error) => error.scope === `task:${taskId}`);
  return (
    <article className={`workspace-row${selected ? ' selected' : ''}`} role="listitem" aria-label={task.title} onDrop={onDrop}>
      <div
        className="workspace-heading"
        draggable={!busy}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(dragType, JSON.stringify({ session: model.session, taskId }));
        }}
      >
        {task.worktree ? (
          <IconButton
            label={`${row.expanded ? '收起' : '展开'}${task.title}的变更文件`}
            aria-expanded={row.expanded}
            onClick={() => send({ type: 'task.toggle', taskId, expanded: !row.expanded })}
          >
            {row.expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </IconButton>
        ) : (
          <GitBranch className="workspace-plan-icon" aria-hidden="true" />
        )}
        <button
          type="button"
          className="workspace-title"
          title={row.tooltip}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onClick={() => send({ type: 'task.select', taskId })}
          onKeyDown={(event) => {
            if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              event.preventDefault();
              onReorder(event.key === 'ArrowUp' ? -1 : 1);
            }
          }}
        >
          {task.title}
        </button>
        {row.description && (
          <span className="workspace-status" title={row.tooltip}>
            {row.description}
          </span>
        )}
      </div>
      <div className="workspace-actions" role="toolbar" aria-label={`${task.title}操作`}>
        {task.worktree ? (
          <>
            <IconButton label="打开工作区" onClick={() => send({ type: 'task.open', taskId })}>
              <FolderOpen aria-hidden="true" />
            </IconButton>
            <IconButton label="与 Agent 对话" onClick={() => send({ type: 'task.chat', taskId })}>
              <MessageSquare aria-hidden="true" />
            </IconButton>
            <IconButton
              label={connected ? '断开预览' : '连接预览'}
              aria-pressed={connected}
              disabled={busy}
              onClick={() => send({ type: 'task.connect', taskId })}
            >
              {connected ? <Unplug aria-hidden="true" /> : <Plug aria-hidden="true" />}
            </IconButton>
            <IconButton label={commitLabel} disabled={busy} onClick={() => send({ type: 'task.commit', taskId })}>
              <GitCommitHorizontal aria-hidden="true" />
            </IconButton>
            {sync && sync.status !== 'current' && (
              <IconButton
                label={sync.status === 'conflict' ? '同步冲突：查看详情' : '需要同步'}
                title={sync.message}
                disabled={busy}
                onClick={() => send({ type: 'task.sync', taskId })}
              >
                {sync.status === 'conflict' ? <TriangleAlert aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              </IconButton>
            )}
          </>
        ) : task.status === 'archived' ? (
          <IconButton label="恢复计划" disabled={busy} onClick={() => send({ type: 'task.restore', taskId })}>
            <RotateCcw aria-hidden="true" />
          </IconButton>
        ) : (
          <IconButton label="创建工作区" disabled={busy} onClick={() => send({ type: 'task.start', taskId, kind: 'shared' })}>
            <Plus aria-hidden="true" />
          </IconButton>
        )}
        <IconButton label="编辑说明" onClick={() => send({ type: 'task.edit', taskId })}>
          <Pencil aria-hidden="true" />
        </IconButton>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <IconButton label="更多任务操作">
              <MoreHorizontal aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {task.worktree && (
              <DropdownMenuItem onSelect={() => send({ type: 'task.review', taskId })}>
                <FileDiff aria-hidden="true" />
                打开变更
              </DropdownMenuItem>
            )}
            {task.worktree && (
              <DropdownMenuItem onSelect={() => send({ type: 'task.history', taskId })}>
                <History aria-hidden="true" />
                交付记录
              </DropdownMenuItem>
            )}
            {task.worktree && (
              <DropdownMenuItem onSelect={() => send({ type: 'task.copy', taskId })}>
                <Copy aria-hidden="true" />
                复制路径
              </DropdownMenuItem>
            )}
            {!task.worktree && task.status !== 'archived' && (
              <DropdownMenuItem onSelect={() => send({ type: 'task.options', taskId })}>
                <Settings2 aria-hidden="true" />
                工作区选项
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => send({ type: 'task.brief', taskId })}>
              <FileText aria-hidden="true" />
              复制任务说明
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {errors.map((error) => (
        <p role="alert" className="error" key={error.scope}>
          {error.message}
        </p>
      ))}
      {task.integration?.error && (
        <p role="alert" className="error">
          {task.integration.error}
        </p>
      )}
      {task.worktree && task.workspaceHook?.status === 'failed' && (
        <div className="task-hook-failure notice" role="alert">
          <span>初始化脚本失败</span>
          <IconButton label="查看脚本输出" onClick={() => send({ type: 'task.output', taskId })}>
            <ScrollText aria-hidden="true" />
          </IconButton>
          <IconButton label="重试初始化脚本" disabled={busy} onClick={() => send({ type: 'task.hook', taskId })}>
            <RefreshCw aria-hidden="true" />
          </IconButton>
        </div>
      )}
      {task.integration && (
        <div className="task-hook-failure notice">
          <span>{model.workflow?.preparation?.changeId === taskId ? (model.workflow.preparation.message ?? '提交准备内容已保留') : '提交准备内容已保留'}</span>
          <IconButton label="结束已恢复的提交准备" disabled={busy} onClick={() => send({ type: 'task.resume', taskId })}>
            <RotateCcw aria-hidden="true" />
          </IconButton>
        </div>
      )}
      {selected && <Task key={taskDraftKey(model)} model={model} send={send} state={state} />}
      {task.worktree && row.expanded && (
        <div className="workspace-files" role="group" aria-label={`${task.title}的变更文件`}>
          {row.filesError ? (
            <p role="alert" className="error">
              {row.filesError}
            </p>
          ) : !row.files ? (
            <p role="status" className="muted">
              正在读取变更…
            </p>
          ) : !row.files.length ? (
            <p className="muted">暂无变更</p>
          ) : (
            row.files.map((file) => (
              <button
                type="button"
                className="workspace-file"
                key={file.path}
                title={fileTitle(file)}
                onClick={() => send({ type: 'task.file', taskId, path: file.path })}
              >
                <FileDiff aria-hidden="true" />
                <span>{file.path}</span>
                <small>
                  +{file.additions} −{file.deletions}
                </small>
              </button>
            ))
          )}
        </div>
      )}
    </article>
  );
}
