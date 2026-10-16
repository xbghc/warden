import { useEffect, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, FileCode2, GitBranch, MessageSquare, RefreshCw, Send, Terminal } from 'lucide-react';
import type { DevelopmentChange, WorkflowTask, SlotKind } from '@warden/shared';
import { tryParseTargetKey } from '@warden/shared';
import { api } from '../api';
import { useStore, useTracksViewed } from '../store';
import { changeTarget, preparationTarget, useWorkflow, workflowAction } from '../workflow-store';
import { useWorkbench } from '../workbench-store';
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
  const [kind, setKind] = useState<SlotKind>('worktree');
  const [existing, setExisting] = useState('');
  const occupied = new Set(data?.workflow?.changes.filter((change) => change.worktree).map((change) => change.worktree));
  const available = checkouts?.worktrees.filter((row) => !row.isMain && !row.foreign && !row.prunable && !occupied.has(row.path)) ?? [];
  return (
    <>
      <div className="wb-empty-workspace">
        <GitBranch size={30} strokeWidth={1.3} />
        <h2>尚无工作区</h2>
        <p>创建工作区后，在这里查看文件差异、发送 tmux 命令。</p>
        <Button onClick={() => setOpen(true)}>创建工作区…</Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen} title="创建工作区" description={`任务：${task.title}`}>
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
            <p>{existing || '目录由现有可用工位与新编号分配；创建结果会显示实际路径。'}</p>
          </div>
          <OperationError message={actionError} />
          <Button disabled={busy}>{busy ? '创建中…' : '创建工作区'}</Button>
        </form>
      </Sheet>
    </>
  );
}

function WorkspaceCommands({ task }: { task: DevelopmentChange }) {
  const config = useWorkflow((state) => state.data?.workspaceConfig);
  const commands = config?.commands ?? [];
  const text = useWorkbench((state) => state.prompts[task.id] ?? '');
  const [commandId, setCommandId] = useState('');
  const [enter, setEnter] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ session: string; pane: string; input: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const command = commands.find((item) => item.id === commandId);
  const send = async (configured: boolean) => {
    setPending(true);
    setError(null);
    try {
      const response =
        configured && command
          ? await api.runWorkspaceCommand(command.id, task.worktree)
          : await api.sendWorkspaceInput({ path: task.worktree, text, ...(enter ? { keys: ['Enter'] } : {}) });
      setResult({
        ...response,
        input: configured && command ? [command.text, command.keys?.join(' ')].filter(Boolean).join('\n') : `${text}${enter ? '\n[Enter]' : ''}`,
      });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="wb-commands">
      <div className="wb-command-row">
        <Terminal size={15} />
        <NativeSelect aria-label="已配置的 tmux 命令" value={commandId} onChange={(event) => setCommandId(event.target.value)}>
          <option value="">选择配置命令</option>
          {commands.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </NativeSelect>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !command}
          onClick={() => void send(true)}
          title={command && [command.text, command.keys?.join(' ')].filter(Boolean).join('\n')}
        >
          运行命令
        </Button>
        {commands.length === 0 && <span className="muted small">在设置中添加通用命令</span>}
      </div>
      <div className="wb-prompt-row">
        <Textarea
          rows={2}
          aria-label="提示词"
          placeholder="输入要发送到工作区 tmux 的文本…"
          value={text}
          onChange={(event) => useWorkbench.getState().setPrompt(task.id, event.target.value)}
        />
        <div>
          <label className="check small">
            <Checkbox checked={enter} onCheckedChange={(value) => setEnter(value === true)} />
            同时发送 Enter
          </label>
          <Button size="sm" disabled={pending || !text} onClick={() => void send(false)}>
            <Send size={14} />
            发送文本
          </Button>
        </div>
      </div>
      {result && (
        <details className="wb-send-result">
          <summary>
            已发送到{' '}
            <code>
              {result.session} {result.pane}
            </code>{' '}
            · 查看发送结果
          </summary>
          <pre>{result.input}</pre>
        </details>
      )}
      <OperationError message={error} />
      {task.workspaceHook && (
        <details className="wb-hook" open={task.workspaceHook.status === 'failed' || undefined}>
          <summary>
            工作区 hook ·{' '}
            {task.workspaceHook.status === 'succeeded'
              ? `退出码 ${task.workspaceHook.exitCode ?? 0}`
              : task.workspaceHook.status === 'failed'
                ? '执行失败，工作区已保留'
                : '执行中或已中断'}
          </summary>
          <code>{task.workspaceHook.command}</code>
          <pre>{task.workspaceHook.output}</pre>
          <Button variant="outline" size="sm" onClick={() => void workflowAction(() => api.retryWorkspaceHook(task.id))}>
            重跑 hook
          </Button>
        </details>
      )}
    </div>
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
      title={retryPreparation ? '重试准备本次合入' : preparation ? '提交到主开发分支' : '准备本次合入'}
      description={`${task.title} → ${task.developmentBranch}`}
    >
      <div className="wb-form">
        <div className="wb-note">
          <strong>本次交付范围</strong>
          <p>相对于已记录交付的未交付变化。{files.length} 个文件。</p>
          <code>{preparation?.worktree ?? task.worktree}</code>
        </div>
        {!preparation && (
          <>
            <p className="muted">准备后，主目录只呈现本次交付。其他连接的贡献会暂时移除。</p>
            {!!preview?.connectedIds.length && <p className="small">当前连接 {preview.connectedIds.length} 个工作区。</p>}
          </>
        )}
        {preparation && (
          <div className="wb-note">
            <strong>{retryPreparation ? '本次准备尚未完成' : preparation.state === 'committed' ? '检测到主开发分支提交' : '本次改动已放入主目录暂存区'}</strong>
            {retryPreparation ? (
              <p>
                重试将继续使用已记录的源提交 {retryPreparation.source.slice(0, 8)} 与主开发分支版本 {retryPreparation.parent.slice(0, 8)}。
              </p>
            ) : (
              <p>你可以在主目录自行运行测试，再决定提交时间。正常 Git hooks 会运行。</p>
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
              ? '主目录已有另一批准备中的改动。'
              : checkout?.dirty !== 0
                ? '本次合入需要先在任务工作区保存为普通提交；实时预览仍可包含未提交变化。'
                : files.length === 0
                  ? '当前没有未交付变化。'
                  : '当前 Git 状态或审查版本尚不支持合入，请刷新检查。'}
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
              {pending ? '准备中…' : '准备本次合入'}
            </Button>
          ) : preparation.state === 'committed' ? (
            <Button
              disabled={pending || !preparation.canRecord || !preparation.head}
              onClick={() =>
                void mutate(async () => {
                  await api.acceptChange(task.id, { mode: 'record', commit: preparation.head! });
                  onOpenChange(false);
                  useStore.getState().showToast('已记录本次交付，工作区继续保留');
                })
              }
            >
              记录已存在的提交
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
                  useStore.getState().showToast('已提交到主开发分支，工作区继续保留');
                })
              }
            >
              {pending ? '提交中…' : '提交到主开发分支'}
            </Button>
          )}
          <Button variant="outline" disabled={pending} onClick={() => void Promise.all([useWorkflow.getState().refresh(), useStore.getState().refresh()])}>
            刷新 Git 状态
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
  const tracks = useTracksViewed();
  return (
    <aside className="wb-files" aria-label="本次变更文件">
      <div className="wb-files-title">
        <strong>本次变更</strong>
        <span>{files.length}</span>
      </div>
      <OperationError message={error} />
      {loading && files.length === 0 && <p className="wb-muted-note">正在读取文件…</p>}
      {!loading && !error && files.length === 0 && <p className="wb-muted-note">当前没有未交付变化。</p>}
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
            {tracks && (
              <Checkbox aria-label={`${file.path} 已读`} checked={file.viewed} onCheckedChange={() => void useStore.getState().toggleViewed(file.path)} />
            )}
          </li>
        ))}
      </ul>
      {tracks && files.length > 0 && (
        <p className="wb-file-progress">
          <Check size={12} />
          {files.filter((file) => file.viewed).length} / {files.length} 个文件已读
        </p>
      )}
    </aside>
  );
}

export function TaskWorkspace({ task, active }: { task: WorkflowTask; active: boolean }) {
  const { data, checkouts } = useWorkflow();
  const fileCount = useStore((state) => state.files.length);
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
    if (active) useStore.setState({ reviewReadOnly: true, panel: 'diff' });
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
          <span className="wb-eyebrow">
            工作计划 ·{' '}
            {(data?.workflow?.changes
              .filter((row) => row.developmentBranch === task.developmentBranch && row.status !== 'archived')
              .findIndex((row) => row.id === task.id) ?? 0) + 1}
          </span>
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
        <Button variant="outline" size="sm" onClick={() => setEditing(!editing)}>
          编辑说明
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
              <Button size="sm">保存说明</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          </form>
        ) : (
          task.body && (
            <details className="wb-description">
              <summary>
                任务说明 <ChevronDown size={13} />
              </summary>
              <Markdown text={task.body} />
            </details>
          )
        )}
        {task.worktree && (
          <>
            <div className="wb-task-facts">
              <span>{deliveries.length ? `已记录 ${deliveries.length} 批交付` : '尚无交付记录'}</span>
              <span>本次 {fileCount} 个变更文件</span>
              {checkout && checkout.dirty > 0 && <span>{checkout.dirty} 项未提交变化</span>}
              {checkout?.busy && <span>Git 操作：{checkout.busy}</span>}
            </div>
            {deliveries.length > 0 && (
              <details className="wb-deliveries">
                <summary>已记录交付</summary>
                {deliveries.map((delivery, index) => (
                  <p key={delivery.id}>
                    <span>第 {index + 1} 批</span>
                    <code>{delivery.commit.slice(0, 8)}</code>
                    <span>{delivery.message.split('\n')[0]}</span>
                  </p>
                ))}
              </details>
            )}
            <WorkspaceCommands task={task} />
          </>
        )}
      </div>
      {!task.worktree ? (
        <WorkspaceCreation task={task} />
      ) : (
        <>
          <div className="wb-review-toolbar">
            <div>
              <strong>{isPrepared ? '主目录中的本次交付' : '未交付变化'}</strong>
              <span className="muted small">相对于已记录交付</span>
            </div>
            <div className="wb-actions">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="刷新文件"
                onClick={() => void Promise.all([useWorkflow.getState().refresh(), useStore.getState().refresh()])}
              >
                <RefreshCw size={15} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="wb-diff-layout"
                onClick={() => useStore.getState().setViewMode(viewMode === 'split' ? 'unified' : 'split')}
              >
                {viewMode === 'split' ? '统一差异' : '并排差异'}
              </Button>
              <Button size="sm" variant={railOpen ? 'secondary' : 'ghost'} onClick={() => useStore.getState().setRailOpen(!railOpen)}>
                <MessageSquare size={14} />
                评论{commentCount ? ` ${commentCount}` : ''}
              </Button>
            </div>
          </div>
          <div className={`wb-review${mobileFileList ? ' show-file-list' : ''}`}>
            <TaskFiles />
            <div className="wb-diff">
              <Button className="wb-mobile-only wb-back-files" size="sm" variant="ghost" onClick={() => setMobileFileList(true)}>
                <ArrowLeft size={14} />
                文件列表
              </Button>
              <DiffPanel />
            </div>
            <Rail />
          </div>
          <footer className="wb-task-footer">
            <span>
              {preparationIncomplete
                ? '本次合入准备尚未完成，可查看原因并重试。'
                : isPrepared
                  ? '连接预览已暂停，主目录正在准备本次交付。'
                  : '文件选择用于审查；连接在主目录预览中管理。'}
            </span>
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
