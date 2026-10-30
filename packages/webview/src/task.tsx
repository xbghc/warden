import { useEffect, useRef, useState } from 'react';
import { Check, Plus, RefreshCw, X } from 'lucide-react';
import type { TaskSection, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { IconButton } from './components/ui/icon-button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';

export interface ViewState {
  read<T>(key: string, fallback: T): T;
  save(key: string, value: unknown): void;
}
type Draft = { title: string; body: string; agent: string; kind: 'shared' | 'clone'; section: TaskSection; request?: string };
export const taskDraftKey = (model: WorkbenchModel) =>
  `task:v1:${model.repository}:${model.creating ? `new:${model.workflow?.workflow?.developmentBranch ?? ''}` : (model.task?.id ?? 'none')}`;

export function Task({ model, send, state }: { model: WorkbenchModel; send(action: WorkbenchAction): void; state: ViewState }) {
  const task = model.task;
  const key = taskDraftKey(model);
  const [draft, setDraft] = useState(() => {
    const saved = state.read<Draft>(key, {
      title: task?.title ?? '',
      body: task?.body ?? '',
      agent: task?.agent ?? '',
      kind: 'shared',
      section: 'commit',
    });
    // Older versions stored the removed details pane beside otherwise reusable note drafts.
    return { ...saved, section: ['edit', 'history', 'hook', 'workspace'].includes(saved.section) ? saved.section : ('commit' as TaskSection) };
  });
  const [saving, setSaving] = useState(false);
  const latest = useRef(draft);
  const update = (patch: Partial<Draft>) => {
    const value = { ...latest.current, ...patch };
    latest.current = value;
    setDraft(value);
    state.save(key, value);
  };
  useEffect(() => {
    if (model.taskSection && model.taskSection.request !== latest.current.request)
      update({ section: model.taskSection.section, request: model.taskSection.request });
  }, [model.taskSection?.request]);
  useEffect(() => {
    if (saving && task?.title === draft.title && (task.body ?? '') === draft.body) {
      setSaving(false);
      update({ section: 'commit' });
    }
  }, [task?.title, task?.body, saving]);
  useEffect(() => {
    if (task?.worktree && draft.section === 'workspace') update({ section: 'commit' });
  }, [task?.worktree]);
  if (model.creating)
    return (
      <section className="task-inline task-create" aria-label="新增任务">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!model.busy && draft.title.trim()) send({ type: 'task.create', title: draft.title.trim(), body: '' });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && !model.busy) {
              event.preventDefault();
              event.stopPropagation();
              send({ type: 'task.cancelCreate' });
            }
          }}
        >
          <Input
            aria-label="任务说明"
            placeholder="输入任务说明"
            required
            autoFocus
            maxLength={200}
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
          />
          <IconButton label="添加任务" variant="default" type="submit" disabled={!!model.busy || !draft.title.trim()}>
            <Check aria-hidden="true" />
          </IconButton>
          <IconButton label="取消新增任务" disabled={!!model.busy} onClick={() => send({ type: 'task.cancelCreate' })}>
            <X aria-hidden="true" />
          </IconButton>
        </form>
      </section>
    );
  if (!model.creating && (!task || draft.section === 'commit')) return null;
  const taskId = task?.id ?? '';
  const hook = task?.worktree ? task.workspaceHook : undefined;
  const deliveries = task?.worktree ? task.deliveries : undefined;
  const title = { commit: '', edit: '编辑说明', history: '交付记录', hook: '初始化脚本', workspace: '工作区选项' }[draft.section];
  return (
    <section className="task-inline" aria-label={title}>
      <div className="task-section-heading">
        <h2>{title}</h2>
        <IconButton label="关闭面板" onClick={() => update({ section: 'commit' })}>
          <X aria-hidden="true" />
        </IconButton>
      </div>
      {draft.section === 'edit' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send({ type: 'task.update', taskId, title: draft.title, body: draft.body });
            setSaving(true);
          }}
        >
          <div className="field">
            <Input
              aria-label="标题"
              placeholder="任务标题"
              required
              maxLength={200}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </div>
          <div className="field">
            <Textarea
              aria-label="说明"
              placeholder="补充说明（可选）"
              rows={5}
              maxLength={10000}
              value={draft.body}
              onChange={(event) => update({ body: event.target.value })}
            />
          </div>
          <div className="actions">
            <IconButton label="保存说明" variant="default" type="submit" disabled={!!model.busy || !draft.title.trim()}>
              <Check aria-hidden="true" />
            </IconButton>
            <IconButton
              label="取消编辑"
              onClick={() => {
                setSaving(false);
                update({ section: 'commit', title: task!.title, body: task!.body ?? '' });
              }}
            >
              <X aria-hidden="true" />
            </IconButton>
          </div>
        </form>
      ) : draft.section === 'history' ? (
        <div className="task-details">
          {!deliveries?.length && <p className="muted">暂无交付记录</p>}
          {deliveries?.map((delivery) => (
            <div className="delivery" key={delivery.id}>
              <code>{delivery.commit.slice(0, 8)}</code>
              <p className="whitespace-pre-wrap">{delivery.message}</p>
            </div>
          ))}
        </div>
      ) : draft.section === 'hook' ? (
        <div className="task-details">
          <p>
            {hook ? { running: '运行中', succeeded: '成功', failed: '失败' }[hook.status] : '尚未运行'} · 退出码 {hook?.exitCode ?? '—'}
          </p>
          {hook?.command && <pre>{hook.command}</pre>}
          <pre>{hook?.output || '暂无输出'}</pre>
          <IconButton label="重试初始化脚本" disabled={!!model.busy} onClick={() => send({ type: 'task.hook', taskId })}>
            <RefreshCw aria-hidden="true" />
          </IconButton>
        </div>
      ) : draft.section === 'workspace' && !task?.worktree ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send({ type: 'task.start', taskId, kind: draft.kind, agent: draft.agent });
          }}
        >
          <div className="field">
            <Input
              aria-label="执行者（可选）"
              maxLength={100}
              value={draft.agent}
              onChange={(event) => update({ agent: event.target.value })}
              placeholder="执行者名称（可选）"
            />
          </div>
          <div className="field">
            <NativeSelect aria-label="Git 存储方式" value={draft.kind} onChange={(event) => update({ kind: event.target.value as Draft['kind'] })}>
              <NativeSelectOption value="shared">共享 Git 存储</NativeSelectOption>
              <NativeSelectOption value="clone">独立 clone（兼容模式）</NativeSelectOption>
            </NativeSelect>
          </div>
          <IconButton label="创建工作区" variant="default" type="submit" disabled={!!model.busy}>
            <Plus aria-hidden="true" />
          </IconButton>
        </form>
      ) : null}
    </section>
  );
}
