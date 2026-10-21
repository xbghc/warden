import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, Columns2, FileCode2, GitBranch, MessageSquare, Pencil, RefreshCw, Save, X } from 'lucide-react';
import type { DevelopmentChange, WorkflowTask, SlotKind } from '@warden/shared';
import { tryParseTargetKey } from '@warden/shared';
import { api } from '../api';
import { useStore } from '../store';
import { changeTarget, preparationTarget, useWorkflow, workflowAction } from '../workflow-store';
import { errorMessage, useWorkbenchData } from '../workbench-data';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { Checkbox } from './ui/checkbox';
import { Sheet } from './ui/sheet';
import { DiffPanel } from './DiffPanel';
import { Rail } from './Rail';
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
  const [kind, setKind] = useState<SlotKind>('clone');
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
                <option value="worktree">Git worktree</option>
                <option value="clone">独立 clone</option>
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

function DeliveryPanel({ task, open, onOpenChange }: { task: DevelopmentChange; open: boolean; onOpenChange(open: boolean): void }) {
  const { data, busy, checkouts } = useWorkflow();
  const targetKey = useStore((state) => state.targetKey);
  const files = useStore((state) => state.files);
  const [message, setMessage] = useState(task.integration?.message ?? task.title);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const preview = useWorkbenchData((state) => state.preview);
  const preparation = data?.preparation?.changeId === task.id ? data.preparation : undefined;
  const retryPreparation = task.status === 'integrating' && task.integration && !task.integration.prepared ? task.integration : undefined;
  const target = tryParseTargetKey(targetKey);
  const checkout = checkouts?.worktrees.find((row) => row.path === task.worktree);
  const sourceHead = target?.kind === 'range' ? target.head : undefined;
  const sourceValid =
    !!checkout &&
    checkout.dirty === 0 &&
    !checkout.busy &&
    !checkout.foreign &&
    !checkout.prunable &&
    checkout.branch === task.branch &&
    sourceHead === checkout.head;
  const canPrepare = sourceValid && !!sourceHead && !!data?.developmentHead && !data?.preparation && files.length > 0;
  const mutate = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await operation();
      await Promise.all([useWorkflow.getState().refresh(), useStore.getState().reloadRepo(), useWorkbenchData.getState().refresh()]);
    } catch (error) {
      setError(errorMessage(error));
      await useWorkflow.getState().refresh();
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={retryPreparation ? '重试准备' : preparation ? '提交到主开发分支' : '准备合入'}
      description={`${task.title} → ${task.developmentBranch}`}
    >
      <div className="wb-form">
        <div className="wb-note">
          <strong>交付范围</strong>
          <p>{files.length} 个文件 · 未交付变更</p>
          <code>{preparation?.worktree ?? task.worktree}</code>
        </div>
        {!preparation && (
          <p className="muted">
            变更将放入主目录暂存区。
            {!!preview?.connectedIds.length && `${preview.connectedIds.length} 个已连接工作区的预览将暂时移除。`}
          </p>
        )}
        {preparation && (
          <div className="wb-note">
            <strong>{retryPreparation ? '准备未完成' : preparation.state === 'committed' ? '检测到新提交' : '已暂存到主目录'}</strong>
            {retryPreparation ? (
              <p>
                重试使用源提交 {retryPreparation.source.slice(0, 8)} 与主开发分支 {retryPreparation.parent.slice(0, 8)}。
              </p>
            ) : (
              <p>可在主目录测试后提交，Git hooks 照常运行。</p>
            )}
            {preparation.message && <p>{preparation.message}</p>}
          </div>
        )}
        <label className="wb-field">
          提交说明
          <Textarea aria-label="提交说明" rows={4} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={10000} />
        </label>
        <OperationError message={error ?? task.integration?.error} />
        {!preparation && !retryPreparation && !canPrepare && (
          <p className="wb-muted-note">
            {data?.preparation
              ? '请先完成主目录中的另一批交付。'
              : checkout && checkout.dirty > 0
                ? '请先在任务工作区提交变更，再准备合入。'
                : files.length === 0
                  ? '暂无未交付变更。'
                  : '当前状态无法合入，请刷新后检查。'}
          </p>
        )}
        <div className="wb-actions">
          {retryPreparation ? (
            <Button
              disabled={pending || busy}
              onClick={() => void mutate(() => api.prepareChange(task.id, { sourceHead: retryPreparation.source, developmentHead: retryPreparation.parent }))}
            >
              {pending ? '准备中…' : '重试准备'}
            </Button>
          ) : !preparation ? (
            <Button
              disabled={pending || busy || !canPrepare}
              onClick={() => void mutate(() => api.prepareChange(task.id, { sourceHead: sourceHead!, developmentHead: data!.developmentHead! }))}
            >
              {pending ? '准备中…' : '准备合入'}
            </Button>
          ) : preparation.state === 'committed' ? (
            <Button
              disabled={pending || !preparation.canRecord || !preparation.head}
              onClick={() =>
                void mutate(async () => {
                  await api.acceptChange(task.id, { mode: 'record', commit: preparation.head! });
                  onOpenChange(false);
                  useStore.getState().showToast('交付已记录');
                })
              }
            >
              记录现有提交
            </Button>
          ) : (
            <Button
              disabled={pending || !preparation.canCommit || !preparation.head || !preparation.indexFingerprint || !message.trim()}
              onClick={() =>
                void mutate(async () => {
                  await api.acceptChange(task.id, {
                    mode: 'commit',
                    developmentHead: preparation.head!,
                    indexFingerprint: preparation.indexFingerprint!,
                    message,
                  });
                  onOpenChange(false);
                  useStore.getState().showToast('已提交到主开发分支');
                })
              }
            >
              {pending ? '提交中…' : '提交到主开发分支'}
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            disabled={pending}
            onClick={() => void Promise.all([useWorkflow.getState().refresh(), useStore.getState().refresh()])}
            aria-label="刷新状态"
            title="刷新状态"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function TaskFiles() {
  const files = useStore((state) => state.files);
  const active = useStore((state) => state.activeFile);
  const loading = useStore((state) => state.filesLoading);
  const error = useStore((state) => state.filesError);
  return (
    <aside className="wb-files" aria-label="本次变更文件">
      <div className="wb-files-title">
        <strong>文件</strong>
        {!error && (!loading || files.length > 0) && (
          <span>{files.length > 0 ? `已读 ${files.filter((file) => file.viewed).length}/${files.length}` : files.length}</span>
        )}
      </div>
      <OperationError message={error} />
      {loading && files.length === 0 && <p className="wb-muted-note">加载中…</p>}
      {!loading && !error && files.length === 0 && <p className="wb-muted-note">暂无变更</p>}
      <ul>
        {files.map((file) => (
          <li key={file.path} className={active === file.path ? 'is-active' : ''}>
            <button type="button" onClick={() => void useStore.getState().openFile(file.path)} aria-label={`打开 ${file.path}`} title={file.path}>
              <FileCode2 size={15} />
              <span>{file.path}</span>
              <small className={`status-${file.status}`}>
                {file.conflicted ? 'U' : { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[file.status]}
              </small>
            </button>
            <Checkbox aria-label={`${file.path} 已读`} checked={file.viewed} onCheckedChange={() => void useStore.getState().toggleViewed(file.path)} />
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function TaskWorkspace({ task, active }: { task: WorkflowTask; active: boolean }) {
  const { checkouts } = useWorkflow();
  const viewMode = useStore((state) => state.prefs.viewMode);
  const railOpen = useStore((state) => state.prefs.railOpen);
  const commentCount = useStore((state) => state.comments.length);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? '');
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [mobileFileList, setMobileFileList] = useState(true);
  const activeFile = useStore((state) => state.activeFile);
  const isPrepared = task.status === 'integrating' && !!task.integration?.prepared;
  const preparationIncomplete = task.status === 'integrating' && !isPrepared;
  const target = task.worktree ? (isPrepared ? preparationTarget(task) : changeTarget(task)) : undefined;
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
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="刷新文件"
                title="刷新文件"
                onClick={() => void Promise.all([useWorkflow.getState().refresh(), useStore.getState().refresh()])}
              >
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
              <Button
                size={commentCount ? 'sm' : 'icon-sm'}
                variant={railOpen ? 'secondary' : 'ghost'}
                aria-label={`评论${commentCount ? ` ${commentCount}` : ''}`}
                aria-pressed={railOpen}
                title="评论"
                onClick={() => useStore.getState().setRailOpen(!railOpen)}
              >
                <MessageSquare size={14} aria-hidden="true" />
                {commentCount > 0 && <span aria-hidden="true">{commentCount}</span>}
              </Button>
            </div>
          </div>
          <div className={`wb-review${mobileFileList ? ' show-file-list' : ''}`}>
            <TaskFiles />
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
            <Rail />
          </div>
          <footer className="wb-task-footer">
            {(preparationIncomplete || isPrepared) && <span>{preparationIncomplete ? '准备未完成' : '预览已暂停'}</span>}
            <Button size="sm" onClick={() => setDeliveryOpen(true)}>
              {preparationIncomplete ? '重试准备…' : isPrepared ? '提交到主开发分支…' : '准备合入…'}
            </Button>
          </footer>
          <DeliveryPanel task={task} open={deliveryOpen} onOpenChange={setDeliveryOpen} />
        </>
      )}
    </section>
  );
}
