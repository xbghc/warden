import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, FileDiff } from 'lucide-react';
import type { HistoryPreviewRequest, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import { AcpSetup } from './components/AcpSetup';
import { Checkbox } from './components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { Task, taskDraftKey } from './task';
import type { ViewState } from './task';
import { Workspaces } from './workspaces';
import { IconButton } from './components/ui/icon-button';

type Props = { model: WorkbenchModel; send(action: WorkbenchAction): void; state?: ViewState };
const labels: Record<string, string> = {
  pending: '待同步',
  updating: '同步中',
  synced: '已同步',
  conflict: '冲突',
  error: '同步失败',
  current: '已更新',
  stale: '待更新',
  disconnected: '仅主目录',
  paused: '待迁移',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  ready: '预计可同步',
  blocked: '暂不可同步',
  unknown: '无法判断',
  updated: '已同步',
  skipped: '未执行',
};
const label = (value: string | undefined) => (value ? (labels[value] ?? value) : '未检查');

export function WorkbenchApp({ model, send, state: persisted }: Props) {
  const memory = useRef<Record<string, unknown>>({});
  const state = useMemo<ViewState>(
    () =>
      persisted ?? {
        read: <T,>(key: string, fallback: T) => (memory.current[key] as T | undefined) ?? fallback,
        save: (key, value) => {
          memory.current[key] = value;
        },
      },
    [persisted],
  );
  const previous = useRef(model);
  useEffect(() => {
    if (previous.current.creating && !model.creating && model.task && previous.current.repository === model.repository)
      state.save(taskDraftKey(previous.current), undefined);
    previous.current = model;
  }, [model.creating, model.task?.id, model.repository]);
  const scope = model.surface === 'task' ? `task:${model.task?.id ?? 'new'}` : model.surface;
  return (
    <main className={model.surface === 'workspaces' ? 'workspace-pane task-pane' : model.surface === 'task' ? 'task-pane' : undefined}>
      {model.busy && (
        <p role="status" className="muted">
          {model.busy}
        </p>
      )}
      {model.errors
        .filter(
          (error) => error.scope === scope || error.scope === 'repository' || (model.surface === 'workspaces' && model.creating && error.scope === 'task:new'),
        )
        .map((error) => (
          <div role="alert" className="error" key={error.scope}>
            {error.message}
            {error.code && <small className="block muted">{error.code}</small>}
          </div>
        ))}
      {!model.repository ? (
        <Setup repository={false} busy={!!model.busy} send={send} />
      ) : !model.workflow ? (
        <p className="muted" role="status">
          正在加载…
        </p>
      ) : !model.workflow.workflow && model.surface !== 'settings' ? (
        <Setup repository busy={!!model.busy} send={send} />
      ) : (
        <>
          {model.surface === 'task' && <Task key={taskDraftKey(model)} model={model} send={send} state={state} />}
          {model.surface === 'workspaces' && <Workspaces model={model} send={send} state={state} />}
          {model.surface === 'preview' && <Preview model={model} send={send} />}
          {model.surface === 'history' && <History model={model} send={send} />}
          {model.surface === 'settings' && <Settings model={model} send={send} />}
          {model.surface === 'rebase' && <Rebase model={model} send={send} />}
        </>
      )}
    </main>
  );
}

function Setup({ repository, busy, send }: { repository: boolean; busy: boolean; send: Props['send'] }) {
  return (
    <div className="setup">
      <p>{repository ? '选择本需求使用的主开发分支。' : '选择主目录所在的 Git 仓库。'}</p>
      <Button disabled={busy} onClick={() => send({ type: repository ? 'setup.branch' : 'setup.repository' })}>
        {repository ? '选择主开发分支' : '选择仓库'}
      </Button>
    </div>
  );
}

function Preview({ model, send }: Props) {
  const preview = model.preview;
  const hasSetup = !!model.workflow?.workspaceConfig?.previewSetup?.trim();
  const names = preview?.connectedIds.map((id) => model.workflow?.workflow?.changes.find((task) => task.id === id)?.title ?? id);
  return (
    <>
      <h1>预览</h1>
      <p>主开发分支：{model.workflow?.workflow?.developmentBranch ?? '尚未选择'}</p>
      <p className="path">{preview?.worktree ?? '尚未初始化预览目录'}</p>
      <p>当前组合：{names?.length ? names.join(' + ') : '主目录保存的内容'}</p>
      <p>
        {label(preview?.syncStatus ?? preview?.status)}
        {preview?.updatedAt && ` · 最近成功更新 ${new Date(preview.updatedAt).toLocaleString()}`}
      </p>
      {preview?.message && (
        <div className="error" role="alert">
          {preview.message}
        </div>
      )}
      {!!preview?.conflicts?.length && <pre>{preview.conflicts.join('\n')}</pre>}
      <div className="actions">
        <Button disabled={!!model.busy} onClick={() => send({ type: 'preview.refresh' })}>
          立即同步
        </Button>
        <Button variant="secondary" onClick={() => send({ type: 'preview.terminal' })}>
          打开预览终端
        </Button>
        {model.hasPreviewCommand && (
          <Button variant="secondary" onClick={() => send({ type: 'preview.run' })}>
            运行预览
          </Button>
        )}
        <Button variant="secondary" onClick={() => send({ type: 'preview.copy' })}>
          复制路径
        </Button>
      </div>
      {(hasSetup || preview?.setup) && (
        <section>
          <h2>环境准备</h2>
          <p>{preview?.setup ? label(preview.setup.status) : '尚未运行'}</p>
          {preview?.setup && (
            <details open={preview.setup.status === 'failed'}>
              <summary>输出 · 退出码 {preview.setup.exitCode ?? '—'}</summary>
              <pre>{preview.setup.output ?? '等待输出'}</pre>
            </details>
          )}
          {hasSetup && (
            <Button variant="secondary" disabled={!!model.busy} onClick={() => send({ type: 'preview.setup' })}>
              {preview?.setup ? '重新运行' : '运行准备脚本'}
            </Button>
          )}
        </section>
      )}
    </>
  );
}

function Settings({ model, send }: Props) {
  const config = model.workflow?.workspaceConfig;
  const [initialize, setInitialize] = useState(config?.hooks.create ?? config?.hooks.reuse ?? '');
  const [setup, setSetup] = useState(config?.previewSetup ?? '');
  return (
    <>
      <h1>设置</h1>
      <section aria-label="ACP Agent">
        <h2>ACP Agent</h2>
        <p className="muted">使用支持 ACP v1 的 Agent 或适配器，通过 stdio 连接。</p>
        <Button variant="secondary" size="sm" onClick={() => send({ type: 'settings.agents' })}>
          配置 Agent
        </Button>
        <AcpSetup />
      </section>
      <h2>脚本</h2>
      <p className="path">{model.repository}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send({ type: 'settings.save', config: { hooks: { create: initialize, reuse: initialize }, previewSetup: setup } });
        }}
      >
        <label className="field">
          工作区初始化脚本
          <Textarea rows={4} value={initialize} onChange={(event) => setInitialize(event.target.value)} />
        </label>
        <p className="muted">每次创建新工作区时运行。脚本应可重复执行，工作区路径由环境变量提供。</p>
        {config?.hooks.create !== config?.hooks.reuse && config?.hooks.reuse && (
          <details>
            <summary>历史脚本配置</summary>
            <pre>{config.hooks.reuse}</pre>
            <p>保存后统一使用上面的初始化脚本。</p>
          </details>
        )}
        <label className="field">
          预览准备脚本
          <Textarea rows={4} value={setup} onChange={(event) => setSetup(event.target.value)} />
        </label>
        <p className="muted">在预览初始化及代码更新后运行。请使用幂等脚本，依赖与缓存应被 Git 忽略。</p>
        <Button type="submit" disabled={!!model.busy}>
          保存脚本配置
        </Button>
      </form>
    </>
  );
}

function History({ model, send }: Props) {
  const history = model.history;
  const [draft, setDraft] = useState<HistoryPreviewRequest | undefined>(model.historyDraft);
  const [editingCommit, setEditingCommit] = useState<string>();
  const previousDraft = useRef(model.historyDraft);
  useEffect(() => {
    if (previousDraft.current && !model.historyDraft) {
      setDraft(undefined);
      setEditingCommit(undefined);
    }
    previousDraft.current = model.historyDraft;
  }, [model.historyDraft]);
  const [start, setStart] = useState(model.historyDraft?.start ?? '');
  const save = (next: HistoryPreviewRequest) => {
    setDraft(next);
    send({ type: 'history.draft', draft: next });
  };
  const build = () => {
    if (!history) return;
    setEditingCommit(undefined);
    const index = history.commits.findIndex((commit) => commit.sha === start);
    if (index < 0) return;
    save({ head: history.head, start, commits: history.commits.slice(index).map(({ sha, message }) => ({ sha, message })) });
  };
  const move = (from: number, to: number) => {
    if (!draft || !Number.isInteger(from) || from < 0 || to < 0 || from >= draft.commits.length || to >= draft.commits.length) return;
    const commits = [...draft.commits];
    commits.splice(to, 0, commits.splice(from, 1)[0]!);
    save({ ...draft, commits });
  };
  const stale = !!draft && draft.head !== history?.head;
  const preview = JSON.stringify(draft) === JSON.stringify(model.historyDraft) ? model.historyPreview : undefined;
  return (
    <>
      <h1>提交历史</h1>
      <p>{history?.branch ?? '尚未选择主开发分支'} · 早 → 晚</p>
      <label className="field">
        编排起点
        <NativeSelect value={start} onChange={(event) => setStart(event.target.value)}>
          <NativeSelectOption value="">选择起点，范围到当前 HEAD</NativeSelectOption>
          {history?.commits.map((commit) => (
            <NativeSelectOption key={commit.sha} value={commit.sha}>
              {commit.sha.slice(0, 8)} {commit.message.split('\n')[0]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <Button variant="secondary" disabled={!!model.busy || !start} onClick={build}>
        {stale ? '基于最新历史重建草稿' : '创建历史草稿'}
      </Button>
      {stale && <div className="notice">主开发分支已变化。草稿仍保留，重新选择起点并预览后才能应用。</div>}
      <div className={draft ? 'history-columns' : undefined}>
        <section aria-label="当前历史">
          <h2>当前历史</h2>
          {history?.commits.map((commit) => (
            <div className="commit" key={commit.sha}>
              <div className="commit-heading">
                <code>{commit.sha.slice(0, 8)}</code>
                <IconButton label={`查看提交 ${commit.sha.slice(0, 8)} 的变更`} onClick={() => send({ type: 'history.review', sha: commit.sha })}>
                  <FileDiff aria-hidden="true" />
                </IconButton>
              </div>
              <CommitMessage message={commit.message} />
              {commit.changeId && (
                <small className="muted">来源：{model.workflow?.workflow?.changes.find((task) => task.id === commit.changeId)?.title ?? commit.changeId}</small>
              )}
            </div>
          ))}
        </section>
        {draft && (
          <section aria-label="草稿顺序">
            <h2>草稿顺序</h2>
            {draft.commits.map((commit, index) => (
              <div
                className="commit"
                key={commit.sha}
                draggable={editingCommit !== commit.sha}
                onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  move(Number(event.dataTransfer.getData('text/plain')), index);
                }}
              >
                <div className="commit-heading">
                  <span>
                    {index + 1}. <code>{commit.sha.slice(0, 8)}</code>
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === 0}
                    aria-label={`上移提交 ${index + 1}`}
                    title="上移"
                    onClick={() => move(index, index - 1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === draft.commits.length - 1}
                    aria-label={`下移提交 ${index + 1}`}
                    title="下移"
                    onClick={() => move(index, index + 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={editingCommit === commit.sha ? `完成编辑提交 ${index + 1}` : `编辑提交信息 ${index + 1}`}
                    title={editingCommit === commit.sha ? '完成编辑' : '编辑提交信息'}
                    onClick={() => setEditingCommit(editingCommit === commit.sha ? undefined : commit.sha)}
                  >
                    {editingCommit === commit.sha ? <Check aria-hidden="true" /> : <Pencil aria-hidden="true" />}
                  </Button>
                </div>
                {editingCommit === commit.sha ? (
                  <Textarea
                    autoFocus
                    rows={4}
                    aria-label={`提交信息 ${index + 1}`}
                    value={commit.message}
                    onChange={(event) =>
                      save({ ...draft, commits: draft.commits.map((row, i) => (i === index ? { ...row, message: event.target.value } : row)) })
                    }
                  />
                ) : (
                  <CommitMessage message={commit.message} />
                )}
              </div>
            ))}
            <p className="muted">实际分支尚未改变。调整顺序不会合并提交。</p>
            <div className="actions">
              <Button disabled={!!model.busy || stale} onClick={() => send({ type: 'history.preview', draft })}>
                预览改写结果
              </Button>
              <Button
                variant="secondary"
                disabled={!!model.busy}
                onClick={() => {
                  setDraft(undefined);
                  setEditingCommit(undefined);
                  send({ type: 'history.discard' });
                }}
              >
                丢弃草稿
              </Button>
            </div>
          </section>
        )}
      </div>
      {preview && (
        <section>
          <h2>编排预览</h2>
          <p>{preview.canApply ? '最终文件内容一致，可以应用。' : (preview.message ?? '此编排不能应用。')}</p>
          {!!preview.conflicts.length && <pre>{preview.conflicts.join('\n')}</pre>}
          <details>
            <summary>预览顺序 · {preview.commits.length} 个提交</summary>
            <ol>
              {preview.commits.map((commit) => (
                <li key={commit.source}>
                  <CommitMessage message={commit.message} />
                </li>
              ))}
            </ol>
          </details>
          <Button disabled={!!model.busy || stale || !preview.canApply} onClick={() => send({ type: 'history.apply', id: preview.id!, head: preview.head })}>
            应用到 {history?.branch}
          </Button>
          <p className="muted">改写本地提交历史，不会自动推送。</p>
        </section>
      )}
    </>
  );
}

function CommitMessage({ message }: { message: string }) {
  const newline = message.indexOf('\n');
  const title = newline < 0 ? message : message.slice(0, newline);
  const body = newline < 0 ? '' : message.slice(newline + 1);
  return body.trim() ? (
    <details className="commit-message">
      <summary>{title || '（无标题）'}</summary>
      <p className="whitespace-pre-wrap">{body}</p>
    </details>
  ) : (
    <p className="commit-title">{title || '（无标题）'}</p>
  );
}

function Rebase({ model, send }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (model.rebaseSelection) setSelected(model.rebaseSelection.taskIds);
  }, [model.rebaseSelection?.request]);
  const checks = model.checks?.checks ?? [];
  const selectedChecks = checks.filter((check) => selected.includes(check.changeId));
  const retry = !model.checks || model.errors.some((error) => error.scope === 'rebase' || error.scope === 'repository');
  return (
    <>
      <h1>同步工作区</h1>
      <p>
        基于 {model.workflow?.workflow?.developmentBranch} · {model.workflow?.developmentHead?.slice(0, 8)}
      </p>
      {(checks.length > 0 || retry) && (
        <div className="actions">
          <Button variant="secondary" disabled={!!model.busy} onClick={() => send({ type: 'rebase.check' })}>
            重新检查
          </Button>
          {checks.length > 0 && (
            <>
              <Button variant="secondary" onClick={() => setSelected(checks.map((check) => check.changeId))}>
                选择全部
              </Button>
              <Button variant="secondary" onClick={() => setSelected([])}>
                清空选择
              </Button>
            </>
          )}
        </div>
      )}
      {!model.checks && <p>尚未检查</p>}
      {model.checks && !checks.length && <p>暂无工作区</p>}
      {checks.map((check) => (
        <label className="check" key={check.changeId}>
          <Checkbox
            aria-label={model.workflow?.workflow?.changes.find((task) => task.id === check.changeId)?.title ?? check.changeId}
            checked={selected.includes(check.changeId)}
            onCheckedChange={(checked) => setSelected(checked === true ? [...selected, check.changeId] : selected.filter((id) => id !== check.changeId))}
          />
          <div className="check-body">
            <strong>{model.workflow?.workflow?.changes.find((task) => task.id === check.changeId)?.title ?? check.changeId}</strong>
            <p>
              {label(check.status)} · {new Date(check.checkedAt).toLocaleTimeString()}
            </p>
            {check.message && <p className="muted">{check.message}</p>}
            {check.files?.length ? <pre>{check.files.join('\n')}</pre> : null}
          </div>
        </label>
      ))}
      {checks.length > 0 && (
        <>
          <div className="actions">
            <Button
              disabled={!!model.busy || !selectedChecks.length}
              onClick={() =>
                send({
                  type: 'rebase.run',
                  items: selectedChecks.map(({ changeId, sourceHead, developmentHead }) => ({ changeId, sourceHead, developmentHead })),
                })
              }
            >
              Rebase 所选工作区
            </Button>
          </div>
          <p className="muted">只执行本次选择。未提交改动、版本变化和冲突会逐项报告。</p>
        </>
      )}
      {model.rebaseResult && (
        <section>
          <h2>执行结果</h2>
          {model.rebaseResult.results.map((result) => (
            <div className="notice" key={result.changeId}>
              {model.workflow?.workflow?.changes.find((task) => task.id === result.changeId)?.title ?? result.changeId}：{label(result.status)}
              <p>{result.message}</p>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
