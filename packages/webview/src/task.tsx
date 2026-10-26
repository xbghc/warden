import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, FolderOpen, MessageSquare, MoreHorizontal, Pencil, RefreshCw, Settings2, X } from 'lucide-react';
import type { TaskSection, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { Button } from './components/ui/button';
import { IconButton } from './components/ui/icon-button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './components/ui/dropdown-menu';

export interface ViewState {
  read<T>(key: string, fallback: T): T;
  save(key: string, value: unknown): void;
}
type Draft = { title: string; body: string; agent: string; kind: 'shared' | 'clone'; section: TaskSection; options: boolean };
export const taskDraftKey = (model: WorkbenchModel) =>
  `task:v1:${model.repository}:${model.creating ? `new:${model.workflow?.workflow?.developmentBranch ?? ''}` : (model.task?.id ?? 'none')}`;

export function Task({ model, send, state }: { model: WorkbenchModel; send(action: WorkbenchAction): void; state: ViewState }) {
  const task = model.task;
  const key = taskDraftKey(model);
  const [draft, setDraft] = useState(() =>
    state.read<Draft>(key, {
      title: task?.title ?? '',
      body: task?.body ?? '',
      agent: task?.agent ?? '',
      kind: 'shared',
      section: 'commit',
      options: false,
    }),
  );
  const [message, setMessage] = useState(model.message);
  const [saving, setSaving] = useState(false);
  const latest = useRef(draft);
  const update = (patch: Partial<Draft>) => {
    const value = { ...latest.current, ...patch };
    latest.current = value;
    setDraft(value);
    state.save(key, value);
  };
  useEffect(() => {
    if (model.taskSection) update({ section: model.taskSection.section });
  }, [model.taskSection?.request]);
  useEffect(() => {
    if (saving && task?.title === draft.title && (task.body ?? '') === draft.body) {
      setSaving(false);
      update({ section: 'commit' });
    }
  }, [task?.title, task?.body, saving]);
  useLayoutEffect(() => {
    window.scrollTo(0, state.read(`${key}:scroll`, 0));
    const save = () => state.save(`${key}:scroll`, window.scrollY);
    window.addEventListener('scroll', save);
    return () => window.removeEventListener('scroll', save);
  }, [key]);

  if (!task && !model.creating) return <p className="muted">请选择任务，或在工作区列表添加任务。</p>;
  const taskId = task?.id ?? '';
  const action = (type: 'task.review' | 'task.open' | 'task.chat' | 'task.hook' | 'task.resume' | 'task.copy' | 'task.brief' | 'task.restore') =>
    send({ type, taskId });
  const editing = model.creating || draft.section === 'edit';
  const section = draft.section;
  const hook = task?.worktree ? task.workspaceHook : undefined;
  const deliveries = task?.worktree ? task.deliveries : undefined;
  const hookLabels = { running: '运行中', succeeded: '成功', failed: '失败' };
  const panelTitle = { commit: '', details: '任务详情', history: '交付记录', hook: '初始化脚本', edit: '编辑说明' }[section];
  return (
    <>
      <div className="task-heading">
        <h1 title={task?.title}>{model.creating ? '新增任务' : task?.title}</h1>
        {!model.creating && (
          <div className="task-toolbar">
            {task?.worktree && (
              <IconButton label="打开工作区" onClick={() => action('task.open')}>
                <FolderOpen aria-hidden="true" />
              </IconButton>
            )}
            {task?.worktree && (
              <IconButton label="与 Agent 对话" onClick={() => action('task.chat')}>
                <MessageSquare aria-hidden="true" />
              </IconButton>
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <IconButton label="更多任务操作">
                  <MoreHorizontal aria-hidden="true" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => update({ section: 'details' })}>任务详情</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => update({ section: 'edit' })}>编辑说明</DropdownMenuItem>
                {task?.worktree && <DropdownMenuItem onSelect={() => action('task.review')}>打开变更</DropdownMenuItem>}
                {task?.worktree && <DropdownMenuItem onSelect={() => update({ section: 'history' })}>交付记录</DropdownMenuItem>}
                {hook && <DropdownMenuItem onSelect={() => update({ section: 'hook' })}>初始化脚本</DropdownMenuItem>}
                {task?.worktree && <DropdownMenuItem onSelect={() => action('task.copy')}>复制路径</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => action('task.brief')}>复制任务说明</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {!model.creating && section !== 'commit' && (
        <div className="task-section-heading">
          <h2>{panelTitle}</h2>
          <IconButton label={task?.worktree ? '返回提交' : '返回任务'} onClick={() => update({ section: 'commit' })}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      )}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(
              model.creating
                ? { type: 'task.create', title: draft.title, body: draft.body }
                : { type: 'task.update', taskId, title: draft.title, body: draft.body },
            );
            if (!model.creating) setSaving(true);
          }}
        >
          <label className="field">
            标题
            <Input required maxLength={200} value={draft.title} onChange={(event) => update({ title: event.target.value })} />
          </label>
          <label className="field">
            说明
            <Textarea rows={5} maxLength={10000} value={draft.body} onChange={(event) => update({ body: event.target.value })} />
          </label>
          <div className="actions">
            <IconButton label={model.creating ? '添加任务' : '保存说明'} variant="default" type="submit" disabled={!!model.busy || !draft.title.trim()}>
              <Check aria-hidden="true" />
            </IconButton>
            {!model.creating && (
              <IconButton
                label="取消编辑"
                onClick={() => {
                  setSaving(false);
                  update({ section: 'commit', title: task!.title, body: task!.body ?? '' });
                }}
              >
                <X aria-hidden="true" />
              </IconButton>
            )}
          </div>
        </form>
      ) : section === 'details' ? (
        <div className="task-details">
          <p className="whitespace-pre-wrap">{task?.body || '暂无说明'}</p>
          {task?.agent && <p className="muted">执行者：{task.agent}</p>}
          {task?.branch && <p className="path">{task.branch}</p>}
          {task?.worktree && <p className="path">{task.worktree}</p>}
          <IconButton label="编辑说明" onClick={() => update({ section: 'edit' })}>
            <Pencil aria-hidden="true" />
          </IconButton>
        </div>
      ) : section === 'history' ? (
        <div className="task-details">
          {!deliveries?.length && <p className="muted">暂无交付记录</p>}
          {deliveries?.map((delivery) => (
            <div className="delivery" key={delivery.id}>
              <code>{delivery.commit.slice(0, 8)}</code>
              <p className="whitespace-pre-wrap">{delivery.message}</p>
            </div>
          ))}
        </div>
      ) : section === 'hook' ? (
        <div className="task-details">
          <p>
            {hook ? hookLabels[hook.status] : '尚未运行'} · 退出码 {hook?.exitCode ?? '—'}
          </p>
          {hook?.command && <pre>{hook.command}</pre>}
          <pre>{hook?.output || '暂无输出'}</pre>
          <IconButton label="重试初始化脚本" disabled={!!model.busy} onClick={() => action('task.hook')}>
            <RefreshCw aria-hidden="true" />
          </IconButton>
        </div>
      ) : task && !task.worktree ? (
        <section className="task-create">
          {task.status === 'archived' ? (
            <>
              <p>此计划已归档。</p>
              <Button size="sm" disabled={!!model.busy} onClick={() => action('task.restore')}>
                恢复计划
              </Button>
            </>
          ) : (
            <>
              <div className="actions">
                <Button size="sm" disabled={!!model.busy} onClick={() => send({ type: 'task.start', taskId, kind: draft.kind, agent: draft.agent })}>
                  创建工作区
                </Button>
                <IconButton label="工作区选项" aria-expanded={draft.options} onClick={() => update({ options: !draft.options })}>
                  <Settings2 aria-hidden="true" />
                </IconButton>
              </div>
              {draft.options && (
                <div>
                  <label className="field">
                    执行者（可选）
                    <Input maxLength={100} value={draft.agent} onChange={(event) => update({ agent: event.target.value })} placeholder="名称标签" />
                  </label>
                  <label className="field">
                    Git 存储方式
                    <NativeSelect value={draft.kind} onChange={(event) => update({ kind: event.target.value as Draft['kind'] })}>
                      <NativeSelectOption value="shared">共享 Git 存储</NativeSelectOption>
                      <NativeSelectOption value="clone">独立 clone（兼容模式）</NativeSelectOption>
                    </NativeSelect>
                  </label>
                </div>
              )}
            </>
          )}
        </section>
      ) : task?.worktree ? (
        <section className="task-commit">
          <div className="task-section-heading">
            <h2>未交付变更</h2>
            <IconButton label="打开变更" onClick={() => action('task.review')}>
              <RefreshCw aria-hidden="true" />
            </IconButton>
          </div>
          {!model.review ? (
            <p className="muted">打开差异，审阅本次交付的完整内容。</p>
          ) : !model.reviewCurrent ? (
            <p className="notice">审阅版本已变化，请重新打开差异。</p>
          ) : null}
          {task.integration?.error && (
            <p role="alert" className="error">
              {task.integration.error}
            </p>
          )}
          {model.workflow?.preparation?.changeId === task.id && (
            <p className="notice">{model.workflow.preparation.message ?? '已保留提交准备内容。请重新打开差异后继续。'}</p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              send({ type: 'task.deliver', taskId, message });
            }}
          >
            <label className="field">
              提交信息
              <Textarea
                rows={3}
                value={message}
                maxLength={10000}
                onChange={(event) => {
                  setMessage(event.target.value);
                  send({ type: 'task.message', taskId, message: event.target.value });
                }}
              />
            </label>
            <Button size="sm" type="submit" disabled={!!model.busy || !message.trim()} title="使用普通 Git commit hooks 与签名">
              {task.integration && !task.integration.prepared
                ? '恢复提交准备'
                : model.review?.preparation?.canRecord
                  ? '记录已审阅的提交'
                  : `提交到 ${model.workflow?.workflow?.developmentBranch ?? '主开发分支'}`}
            </Button>
          </form>
          {task.integration && (
            <details>
              <summary>提交恢复</summary>
              <p>手动恢复原主目录内容后，可结束本次准备。Warden 会先验证恢复结果。</p>
              <Button size="sm" variant="secondary" disabled={!!model.busy} onClick={() => action('task.resume')}>
                结束已恢复的提交准备
              </Button>
            </details>
          )}
        </section>
      ) : null}
      {hook?.status === 'failed' && section !== 'hook' && (
        <div className="notice task-hook-failure" role="alert">
          <span>初始化脚本失败</span>
          <IconButton label="查看脚本输出" onClick={() => update({ section: 'hook' })}>
            <MoreHorizontal aria-hidden="true" />
          </IconButton>
        </div>
      )}
    </>
  );
}
