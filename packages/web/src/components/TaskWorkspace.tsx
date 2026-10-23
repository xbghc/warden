import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, Columns2, FileCode2, GitBranch, Pencil, RefreshCw, Save, X } from 'lucide-react';
import type { DevelopmentChange, WorkflowTask, SlotKind, TaskReview } from '@warden/shared';
import { taskReview, sameReview } from '@warden/shared';
import { api } from '../api';
import { useStore } from '../store';
import { useWorkflow, workflowAction } from '../workflow-store';
import { errorMessage, useWorkbenchData } from '../workbench-data';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { Sheet } from './ui/sheet';
import { DiffPanel } from './DiffPanel';
import { Markdown } from './Markdown';

export function OperationError({ message }: { message?: string | null }) {
  return message ? (
    <div className="wb-error" role="alert">
      {message}
    </div>
  ) : null;
}

function WorkspaceCreation({ task }: { task: WorkflowTask }) {
  const { checkouts, data, busy, actionError } = useWorkflow();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<SlotKind>('shared');
  const [existing, setExisting] = useState('');
  const occupied = new Set(data?.workflow?.changes.filter((change) => change.worktree).map((change) => change.worktree));
  const available = checkouts?.worktrees.filter((row) => !row.isMain && !row.foreign && !row.prunable && !occupied.has(row.path)) ?? [];
  return (
    <>
      <div className="wb-empty-workspace">
        <GitBranch size={30} strokeWidth={1.3} />
        <h2>未创建工作区</h2>
        <Button onClick={() => setOpen(true)}>创建工作区…</Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen} title="创建工作区" description={task.title}>
        <form
          className="wb-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await workflowAction(() => api.startChange(task.id, existing ? { worktree: existing } : { kind }));
            if (result) setOpen(false);
          }}
        >
          <label className="wb-field">
            工作区
            <NativeSelect value={existing} onChange={(event) => setExisting(event.target.value)} aria-label="工作区来源">
              <option value="">创建新工作区</option>
              {available.map((row) => (
                <option key={row.path} value={row.path}>
                  {row.path} · {row.branch ?? '未关联分支'}
                </option>
              ))}
            </NativeSelect>
          </label>
          {!existing && (
            <label className="wb-field">
              目录类型
              <NativeSelect value={kind} onChange={(event) => setKind(event.target.value as SlotKind)} aria-label="目录类型">
                <option value="shared">共享 Git 工作区</option>
                <option value="clone">独立 clone（兼容模式）</option>
              </NativeSelect>
            </label>
          )}
          <div className="wb-note">
            <span>主开发分支</span>
            <code>{task.developmentBranch}</code>
          </div>
          <OperationError message={actionError} />
          <Button disabled={busy}>{busy ? '创建中…' : '创建工作区'}</Button>
        </form>
      </Sheet>
    </>
  );
}

function WorkspaceHook({ task }: { task: DevelopmentChange }) {
  const hook = task.workspaceHook;
  if (!hook) return null;
  return (
    <details className="wb-hook" open={hook.status === 'failed' || undefined}>
      <summary>工作区脚本 · {hook.status === 'succeeded' ? '已完成' : hook.status === 'failed' ? '执行失败，工作区已保留' : '执行中或已中断'}</summary>
      <code>{hook.command}</code>
      {hook.status !== 'running' && <p>退出码 {hook.exitCode ?? '未知'}</p>}
      <pre>{hook.output}</pre>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => void workflowAction(() => api.retryWorkspaceHook(task.id))}
        aria-label="重试脚本"
        title="重试脚本"
      >
        <RefreshCw size={14} aria-hidden="true" />
      </Button>
    </details>
  );
}

function DeliveryPanel({
  task,
  review,
  open,
  onOpenChange,
  refreshReview,
}: {
  task: DevelopmentChange;
  review?: TaskReview;
  open: boolean;
  onOpenChange(open: boolean): void;
  refreshReview(): Promise<void>;
}) {
  const { data, busy, checkouts } = useWorkflow();
  const { files, filesLoading, filesError, targetKey } = useStore();
  const [message, setMessage] = useState(task.integration?.message ?? task.title);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const current = data && checkouts ? taskReview(data, task.id, checkouts.worktrees) : undefined;
  const fresh = sameReview(review, current) && targetKey === review?.targetKey && !filesLoading && !filesError;
  const preparation = review?.preparation;
  const retry = task.integration && !task.integration.prepared && data?.preparation?.state !== 'committed' ? task.integration : undefined;
  const canDeliver = fresh && !!review?.sourceHead && !!review.developmentHead && !data?.preparation && files.length > 0;
  const mutate = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await operation();
      await Promise.all([useWorkflow.getState().refresh(), useStore.getState().reloadRepo(), useWorkbenchData.getState().refresh()]);
      onOpenChange(false);
      await refreshReview();
    } catch (error) {
      setError(errorMessage(error));
      await useWorkflow.getState().refresh();
    } finally {
      setPending(false);
    }
  };
  const commit = async () => {
    if (!review || !fresh) return;
    if (preparation?.state === 'committed') {
      await api.acceptChange(task.id, { mode: 'record', commit: preparation.head! });
      useStore.getState().showToast('交付已记录');
    } else if (preparation) {
      await api.acceptChange(task.id, {
        mode: 'commit',
        developmentHead: preparation.head!,
        indexFingerprint: preparation.indexFingerprint!,
        message,
      });
      useStore.getState().showToast('已提交到主开发分支');
    } else {
      await api.deliverChange(task.id, {
        sourceHead: review.sourceHead!,
        sourceBase: review.sourceBase,
        developmentHead: review.developmentHead!,
        message,
      });
      useStore.getState().showToast('已提交到主开发分支');
    }
  };
  const allowed =
    preparation?.state === 'committed' ? fresh && preparation.canRecord : fresh && !!message.trim() && (preparation ? preparation.canCommit : canDeliver);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={retry ? '恢复提交准备' : '提交到主开发分支'}
      description={`${task.title} → ${task.developmentBranch}`}
    >
      <div className="wb-form">
        <div className="wb-note">
          <strong>交付范围</strong>
          <p>
            {files.length} 个文件 · {preparation ? '主目录保留的交付内容' : '未交付变更'}
          </p>
          <code>{review?.sourceHead?.slice(0, 8) ?? preparation?.head?.slice(0, 8) ?? '未提交'}</code>
        </div>
        <p className="muted">请完整审查本次提交。Git hooks 照常运行；测试和运行继续使用预览目录。</p>
        {task.integration && (
          <div className="wb-note">
            <strong>{retry ? '准备未完成' : preparation?.state === 'committed' ? '检测到已有提交' : '交付内容已保留在主目录'}</strong>
            <p>{retry ? '重试原版本的提交准备，随后重新审查。' : '处理失败原因后，刷新审查保留的内容，再继续提交。'}</p>
            {data?.preparation?.message && <p>{data.preparation.message}</p>}
          </div>
        )}
        {preparation?.state !== 'committed' && !retry && (
          <label className="wb-field">
            提交说明
            <Textarea aria-label="提交说明" rows={4} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={10000} />
          </label>
        )}
        <OperationError message={error ?? task.integration?.error} />
        {!fresh ? (
          <p className="wb-muted-note">审查版本已变化或尚未加载完成，请刷新并完整审查后再提交。</p>
        ) : !preparation && !retry && !canDeliver ? (
          <p className="wb-muted-note">
            {data?.preparation ? '请先完成主目录中的另一批交付。' : !review?.sourceHead ? '请先在任务工作区提交变更，再刷新审查。' : '暂无未交付变更。'}
          </p>
        ) : null}
        <div className="wb-actions">
          {retry ? (
            <Button
              disabled={pending || busy}
              onClick={() => void mutate(() => api.prepareChange(task.id, { sourceHead: retry.source, developmentHead: retry.parent }))}
            >
              {pending ? '准备中…' : '重试准备'}
            </Button>
          ) : (
            <Button disabled={pending || busy || !allowed} onClick={() => void mutate(commit)}>
              {pending ? '提交中…' : preparation?.state === 'committed' ? '记录现有提交' : '提交到主开发分支'}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              onOpenChange(false);
              void refreshReview();
            }}
          >
            刷新审查
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function TaskFiles({ onOpenFile }: { onOpenFile(): void }) {
  const files = useStore((state) => state.files);
  const active = useStore((state) => state.activeFile);
  const loading = useStore((state) => state.filesLoading);
  const error = useStore((state) => state.filesError);
  return (
    <aside className="wb-files" aria-label="本次变更文件">
      <div className="wb-files-title">
        <strong>文件</strong>
        {!error && (!loading || files.length > 0) && <span>{files.length}</span>}
      </div>
      <OperationError message={error} />
      {loading && files.length === 0 && <p className="wb-muted-note">加载中…</p>}
      {!loading && !error && files.length === 0 && <p className="wb-muted-note">暂无变更</p>}
      <ul>
        {files.map((file) => (
          <li key={file.path} className={active === file.path ? 'is-active' : ''}>
            <button
              type="button"
              onClick={() => {
                void useStore.getState().openFile(file.path);
                onOpenFile();
              }}
              aria-label={`打开 ${file.path}`}
              title={file.path}
            >
              <FileCode2 size={15} />
              <span>{file.path}</span>
              <small className={`status-${file.status}`}>
                {file.conflicted ? 'U' : { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[file.status]}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function TaskWorkspace({ task, active }: { task: WorkflowTask; active: boolean }) {
  const { data, checkouts } = useWorkflow();
  const [review, setReview] = useState<TaskReview>();
  const viewMode = useStore((state) => state.prefs.viewMode);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? '');
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [mobileFileList, setMobileFileList] = useState(true);
  const activeFile = useStore((state) => state.activeFile);
  const isPrepared = task.status === 'integrating' && (!!task.integration?.prepared || data?.preparation?.state === 'committed');
  const preparationIncomplete = task.status === 'integrating' && !isPrepared;
  const currentReview = data && checkouts ? taskReview(data, task.id, checkouts.worktrees) : undefined;
  const target = review?.changeId === task.id ? review.targetKey : undefined;
  const stale = !!review && !sameReview(review, currentReview);
  const refreshReview = useCallback(async () => {
    await useWorkflow.getState().refresh();
    const state = useWorkflow.getState();
    const next = state.data && state.checkouts ? taskReview(state.data, task.id, state.checkouts.worktrees) : undefined;
    setReview(next);
    if (next) await useStore.getState().setTarget(next.targetKey);
  }, [task.id]);
  useEffect(() => {
    if (!active) return;
    const refresh = () => void refreshReview();
    window.addEventListener('warden:refresh-review', refresh);
    return () => window.removeEventListener('warden:refresh-review', refresh);
  }, [active, refreshReview]);
  useEffect(() => {
    if (active && currentReview && review?.changeId !== task.id) setReview(currentReview);
  }, [active, currentReview, review?.changeId, task.id]);
  useEffect(() => {
    if (active && target && target !== useStore.getState().targetKey) void useStore.getState().setTarget(target);
    if (active) useStore.setState({ panel: 'diff' });
  }, [active, target]);
  useEffect(() => {
    if (activeFile) setMobileFileList(false);
  }, [activeFile]);
  const checkout = checkouts?.worktrees.find((row) => row.path === task.worktree);
  const deliveries = task.worktree ? (task.deliveries ?? []) : [];
  return (
    <section className="wb-task" hidden={!active} aria-label={`任务：${task.title}`}>
      <header className="wb-page-header">
        <div>
          <h1>{task.title}</h1>
          {task.worktree && (
            <p className="wb-task-path">
              <GitBranch size={13} />
              <code>{task.branch}</code>
              <span>·</span>
              <code title={task.worktree}>{task.worktree}</code>
            </p>
          )}
        </div>
        <Button variant="outline" size="icon-sm" onClick={() => setEditing(!editing)} aria-label="编辑说明" title="编辑说明" aria-pressed={editing}>
          <Pencil size={14} aria-hidden="true" />
        </Button>
      </header>
      <div className="wb-task-context">
        {editing ? (
          <form
            className="wb-edit-plan"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await workflowAction(() => api.updateChange(task.id, { title, body }))) setEditing(false);
            }}
          >
            <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="任务标题" required />
            <Textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="任务说明" rows={3} />
            <div className="wb-actions">
              <Button size="icon-sm" aria-label="保存说明" title="保存说明">
                <Save size={14} aria-hidden="true" />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => setEditing(false)} aria-label="取消编辑" title="取消编辑">
                <X size={14} aria-hidden="true" />
              </Button>
            </div>
          </form>
        ) : (
          task.body && (
            <details className="wb-description">
              <summary>
                说明 <ChevronDown size={13} />
              </summary>
              <Markdown text={task.body} />
            </details>
          )
        )}
        {task.worktree && (
          <>
            {checkout && (checkout.dirty > 0 || checkout.busy) && (
              <div className="wb-task-facts">
                {checkout.dirty > 0 && <span>{checkout.dirty} 项未提交</span>}
                {checkout.busy && <span>Git 操作：{checkout.busy}</span>}
              </div>
            )}
            {deliveries.length > 0 && (
              <details className="wb-deliveries">
                <summary>
                  交付 · {deliveries.length} <ChevronDown size={13} aria-hidden="true" />
                </summary>
                {deliveries.map((delivery, index) => (
                  <p key={delivery.id}>
                    <span>第 {index + 1} 批</span>
                    <code>{delivery.commit.slice(0, 8)}</code>
                    <span>{delivery.message.split('\n')[0]}</span>
                  </p>
                ))}
              </details>
            )}
            <WorkspaceHook task={task} />
          </>
        )}
      </div>
      {!task.worktree ? (
        <WorkspaceCreation task={task} />
      ) : (
        <>
          <div className="wb-review-toolbar">
            <strong title={isPrepared ? '主目录中准备提交的本次交付' : '相对于上次交付或工作区基线的变化'}>{isPrepared ? '待提交' : '未交付'}</strong>
            <div className="wb-actions">
              <Button size="icon-sm" variant="ghost" aria-label="刷新文件" title="刷新文件" onClick={() => void refreshReview()}>
                <RefreshCw size={15} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={viewMode === 'split' ? '切换为统一差异' : '切换为并排差异'}
                title={viewMode === 'split' ? '切换为统一差异' : '切换为并排差异'}
                onClick={() => useStore.getState().setViewMode(viewMode === 'split' ? 'unified' : 'split')}
              >
                {viewMode === 'split' ? <FileCode2 size={15} /> : <Columns2 size={15} />}
              </Button>
            </div>
          </div>
          {stale && (
            <p className="wb-muted-note" role="status">
              审查版本已变化，请刷新文件并完整审查后再交付。
            </p>
          )}
          <div className={`wb-review${mobileFileList ? ' show-file-list' : ''}`}>
            <TaskFiles onOpenFile={() => setMobileFileList(false)} />
            <div className="wb-diff">
              <Button
                className="wb-mobile-only wb-back-files"
                size="icon-sm"
                variant="ghost"
                onClick={() => setMobileFileList(true)}
                aria-label="返回文件列表"
                title="返回文件列表"
              >
                <ArrowLeft size={14} aria-hidden="true" />
              </Button>
              <DiffPanel />
            </div>
          </div>
          <footer className="wb-task-footer">
            {(preparationIncomplete || isPrepared) && <span>{preparationIncomplete ? '准备未完成' : '交付内容已保留在主目录'}</span>}
            <Button size="sm" onClick={() => setDeliveryOpen(true)}>
              {preparationIncomplete ? '恢复提交…' : '提交到主开发分支…'}
            </Button>
          </footer>
          <DeliveryPanel task={task} review={review} open={deliveryOpen} onOpenChange={setDeliveryOpen} refreshReview={refreshReview} />
        </>
      )}
    </section>
  );
}
