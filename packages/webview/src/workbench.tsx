import { useEffect, useRef, useState } from 'react';
import type { HistoryPreviewRequest, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';

type Props = { model: WorkbenchModel; send(action: WorkbenchAction): void };
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

export function WorkbenchApp({ model, send }: Props) {
  const scope = model.surface === 'task' ? `task:${model.task?.id ?? 'new'}` : model.surface;
  return (
    <main>
      {model.busy && (
        <p role="status" className="muted">
          {model.busy}
        </p>
      )}
      {model.errors
        .filter((error) => error.scope === scope || error.scope === 'repository')
        .map((error) => (
          <div role="alert" className="error" key={error.scope}>
            {error.message}
            {error.code && <small className="block muted">{error.code}</small>}
          </div>
        ))}
      {!model.repository ? (
        <p>请在 Warden 侧栏选择仓库。</p>
      ) : (
        <>
          {model.surface === 'task' && <Task key={model.creating ? 'new' : (model.task?.id ?? 'none')} model={model} send={send} />}
          {model.surface === 'preview' && <Preview model={model} send={send} />}
          {model.surface === 'history' && <History model={model} send={send} />}
          {model.surface === 'settings' && <Settings model={model} send={send} />}
          {model.surface === 'rebase' && <Rebase model={model} send={send} />}
        </>
      )}
    </main>
  );
}

function Task({ model, send }: Props) {
  const task = model.task;
  const [editing, setEditing] = useState(model.creating);
  const [title, setTitle] = useState(task?.title ?? '');
  const [body, setBody] = useState(task?.body ?? '');
  const [kind, setKind] = useState<'shared' | 'clone'>('shared');
  const [agent, setAgent] = useState(task?.agent ?? '');
  const [message, setMessage] = useState(model.message);
  if (!task && !model.creating) return <p className="muted">请选择任务，或在工作区列表添加任务。</p>;
  const taskId = task?.id ?? '';
  const action = (type: 'task.review' | 'task.chat' | 'task.hook' | 'task.resume' | 'task.copy' | 'task.brief' | 'task.restore') => send({ type, taskId });
  return (
    <>
      <h1>{model.creating ? '新增任务' : task?.title}</h1>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(model.creating ? { type: 'task.create', title, body } : { type: 'task.update', taskId, title, body });
            if (!model.creating) setEditing(false);
          }}
        >
          <label className="field">
            标题
            <Input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="field">
            说明
            <Textarea rows={5} maxLength={10000} value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div className="actions">
            <Button disabled={!!model.busy || !title.trim()} type="submit">
              {model.creating ? '添加任务' : '保存说明'}
            </Button>
            {!model.creating && (
              <Button variant="secondary" type="button" onClick={() => setEditing(false)}>
                取消
              </Button>
            )}
          </div>
        </form>
      ) : (
        <>
          {task?.body && (
            <details>
              <summary>说明</summary>
              <p className="whitespace-pre-wrap">{task.body}</p>
            </details>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setTitle(task!.title);
              setBody(task!.body ?? '');
              setEditing(true);
            }}
          >
            编辑说明
          </Button>
        </>
      )}
      {task && !task.worktree && (
        <section>
          {task.status === 'archived' ? (
            <>
              <p>此计划已归档。</p>
              <Button disabled={!!model.busy} onClick={() => action('task.restore')}>
                恢复计划
              </Button>
            </>
          ) : (
            <>
              <p className="muted">尚无工作区</p>
              <label className="field">
                执行者（可选）
                <Input maxLength={100} value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="名称标签" />
              </label>
              <details>
                <summary>工作区选项</summary>
                <label className="field">
                  Git 存储方式
                  <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                    <option value="shared">共享 Git 存储</option>
                    <option value="clone">独立 clone（兼容模式）</option>
                  </select>
                </label>
              </details>
              <Button disabled={!!model.busy} onClick={() => send({ type: 'task.start', taskId, kind, agent })}>
                创建工作区
              </Button>
            </>
          )}
        </section>
      )}
      {task?.worktree && (
        <>
          <section>
            {task.agent && <p className="muted">执行者：{task.agent}</p>}
            <p>{task.branch}</p>
            <p className="path">{task.worktree}</p>
            <div className="actions">
              <Button size="sm" onClick={() => action('task.review')}>
                打开变更
              </Button>
              <Button size="sm" variant="secondary" onClick={() => action('task.chat')}>
                与 Agent 对话
              </Button>
              <Button size="sm" variant="secondary" onClick={() => action('task.copy')}>
                复制路径
              </Button>
              <Button size="sm" variant="secondary" onClick={() => action('task.brief')}>
                复制任务说明
              </Button>
            </div>
          </section>
          {task.workspaceHook && (
            <details open={task.workspaceHook.status === 'failed'}>
              <summary>初始化脚本 · {label(task.workspaceHook.status)}</summary>
              <p>退出码：{task.workspaceHook.exitCode ?? '—'}</p>
              <pre>{task.workspaceHook.output ?? '等待输出'}</pre>
              <Button size="sm" variant="secondary" disabled={!!model.busy} onClick={() => action('task.hook')}>
                重试初始化脚本
              </Button>
            </details>
          )}
          <section>
            <h2>未交付变更</h2>
            {!model.review ? (
              <p className="muted">打开差异，审阅本次交付的完整内容。</p>
            ) : !model.reviewCurrent ? (
              <p className="notice">审阅版本已变化，请重新打开差异。</p>
            ) : (
              <p className="muted">审阅版本：{(model.review.sourceHead ?? model.review.preparation?.head)?.slice(0, 8) ?? '未提交内容'}</p>
            )}
            {task.integration?.error && (
              <p role="alert" className="error">
                {task.integration.error}
              </p>
            )}
            {model.workflow?.preparation?.changeId === task.id && (
              <p className="notice">{model.workflow.preparation.message ?? '已保留提交准备内容。请重新打开差异后继续。'}</p>
            )}
            <label className="field">
              提交信息
              <Textarea
                rows={4}
                value={message}
                maxLength={10000}
                onChange={(event) => {
                  setMessage(event.target.value);
                  send({ type: 'task.message', taskId, message: event.target.value });
                }}
              />
            </label>
            <Button disabled={!!model.busy || !message.trim()} onClick={() => send({ type: 'task.deliver', taskId, message })}>
              {task.integration && !task.integration.prepared
                ? '恢复提交准备'
                : model.review?.preparation?.canRecord
                  ? '记录已审阅的提交'
                  : `提交到 ${model.workflow?.workflow?.developmentBranch ?? '主开发分支'}`}
            </Button>
            <p className="muted">使用普通 Git commit hooks 与签名。</p>
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
          {!!task.deliveries?.length && (
            <details>
              <summary>交付记录 · {task.deliveries.length}</summary>
              {task.deliveries.map((delivery) => (
                <p key={delivery.id}>
                  <code>{delivery.commit.slice(0, 8)}</code> {delivery.message}
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </>
  );
}

function Preview({ model, send }: Props) {
  const preview = model.preview;
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
        <Button variant="secondary" onClick={() => send({ type: 'preview.run' })}>
          运行预览
        </Button>
        <Button variant="secondary" onClick={() => send({ type: 'preview.copy' })}>
          复制路径
        </Button>
      </div>
      <section>
        <h2>环境 setup</h2>
        <p>{preview?.setup ? label(preview.setup.status) : '尚未配置脚本'}</p>
        {preview?.setup && (
          <details open={preview.setup.status === 'failed'}>
            <summary>输出 · 退出码 {preview.setup.exitCode ?? '—'}</summary>
            <pre>{preview.setup.output ?? '等待输出'}</pre>
          </details>
        )}
        <Button variant="secondary" disabled={!!model.busy} onClick={() => send({ type: 'preview.setup' })}>
          重跑 setup
        </Button>
      </section>
      <p className="muted">代码在主目录或任务工作区修改；测试和开发服务在预览目录运行。</p>
    </>
  );
}

function Settings({ model, send }: Props) {
  const config = model.workflow?.workspaceConfig;
  const [initialize, setInitialize] = useState(config?.hooks.create ?? config?.hooks.reuse ?? '');
  const [setup, setSetup] = useState(config?.previewSetup ?? '');
  return (
    <>
      <h1>脚本设置</h1>
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
          预览 setup
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
  const previousDraft = useRef(model.historyDraft);
  useEffect(() => {
    if (previousDraft.current && !model.historyDraft) setDraft(undefined);
    previousDraft.current = model.historyDraft;
  }, [model.historyDraft]);
  const [start, setStart] = useState(model.historyDraft?.start ?? '');
  const save = (next: HistoryPreviewRequest) => {
    setDraft(next);
    send({ type: 'history.draft', draft: next });
  };
  const build = () => {
    if (!history) return;
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
        <select value={start} onChange={(event) => setStart(event.target.value)}>
          <option value="">选择起点，范围到当前 HEAD</option>
          {history?.commits.map((commit) => (
            <option key={commit.sha} value={commit.sha}>
              {commit.sha.slice(0, 8)} {commit.message.split('\n')[0]}
            </option>
          ))}
        </select>
      </label>
      <Button variant="secondary" disabled={!!model.busy || !start} onClick={build}>
        {stale ? '基于最新历史重建草稿' : '创建历史草稿'}
      </Button>
      {stale && <div className="notice">主开发分支已变化。草稿仍保留，重新选择起点并预览后才能应用。</div>}
      <div className="history-columns">
        <section>
          <h2>当前历史</h2>
          {history?.commits.map((commit) => (
            <div className="commit" key={commit.sha}>
              <code>{commit.sha.slice(0, 8)}</code>
              <p className="whitespace-pre-wrap">{commit.message}</p>
              {commit.changeId && (
                <small className="muted">来源：{model.workflow?.workflow?.changes.find((task) => task.id === commit.changeId)?.title ?? commit.changeId}</small>
              )}
            </div>
          ))}
        </section>
        <section>
          <h2>草稿顺序</h2>
          {!draft && <p className="muted">选择起点以编辑顺序和提交信息。</p>}
          {draft?.commits.map((commit, index) => (
            <div
              className="commit"
              key={commit.sha}
              draggable
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
                <Button size="xs" variant="secondary" disabled={index === 0} aria-label={`上移提交 ${index + 1}`} onClick={() => move(index, index - 1)}>
                  ↑
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={index === draft.commits.length - 1}
                  aria-label={`下移提交 ${index + 1}`}
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </Button>
              </div>
              <Textarea
                aria-label={`提交信息 ${index + 1}`}
                value={commit.message}
                onChange={(event) => save({ ...draft, commits: draft.commits.map((row, i) => (i === index ? { ...row, message: event.target.value } : row)) })}
              />
            </div>
          ))}
          {draft && (
            <>
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
                    send({ type: 'history.discard' });
                  }}
                >
                  丢弃草稿
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
      {preview && (
        <section>
          <h2>编排预览</h2>
          <p>{preview.canApply ? '最终文件内容一致，可以应用。' : (preview.message ?? '此编排不能应用。')}</p>
          {!!preview.conflicts.length && <pre>{preview.conflicts.join('\n')}</pre>}
          <ol>
            {preview.commits.map((commit) => (
              <li key={commit.source} className="whitespace-pre-wrap">
                {commit.message}
              </li>
            ))}
          </ol>
          <Button disabled={!!model.busy || stale || !preview.canApply} onClick={() => send({ type: 'history.apply', id: preview.id!, head: preview.head })}>
            应用到 {history?.branch}
          </Button>
          <p className="muted">改写本地提交历史，不会自动推送。</p>
        </section>
      )}
    </>
  );
}

function Rebase({ model, send }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const checks = model.checks?.checks ?? [];
  return (
    <>
      <h1>同步工作区</h1>
      <p>
        基于 {model.workflow?.workflow?.developmentBranch} · {model.workflow?.developmentHead?.slice(0, 8)}
      </p>
      <div className="actions">
        <Button variant="secondary" disabled={!!model.busy} onClick={() => send({ type: 'rebase.check' })}>
          重新检查
        </Button>
        <Button variant="secondary" onClick={() => setSelected(checks.map((check) => check.changeId))}>
          选择全部
        </Button>
        <Button variant="secondary" onClick={() => setSelected([])}>
          清空选择
        </Button>
      </div>
      {!model.checks && <p>尚未检查</p>}
      {model.checks && !checks.length && <p>暂无工作区</p>}
      {checks.map((check) => (
        <label className="check" key={check.changeId}>
          <input
            type="checkbox"
            checked={selected.includes(check.changeId)}
            onChange={(event) => setSelected(event.target.checked ? [...selected, check.changeId] : selected.filter((id) => id !== check.changeId))}
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
      <div className="actions">
        <Button
          disabled={!!model.busy || !selected.length}
          onClick={() =>
            send({
              type: 'rebase.run',
              items: checks
                .filter((check) => selected.includes(check.changeId))
                .map(({ changeId, sourceHead, developmentHead }) => ({ changeId, sourceHead, developmentHead })),
            })
          }
        >
          Rebase 所选工作区
        </Button>
      </div>
      <p className="muted">只执行本次选择。未提交改动、版本变化和冲突会逐项报告。</p>
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
