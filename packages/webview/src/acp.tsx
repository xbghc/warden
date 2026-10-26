import { useEffect, useRef, useState } from 'react';
import type { AcpAction, AcpConfigOption, AcpMessage, AcpModel, AcpPermission, AcpStatus } from '@warden/shared';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './components/ui/native-select';
import { Textarea } from './components/ui/textarea';

type Props = { model: AcpModel; send(action: AcpAction): void };
const statusLabels: Record<AcpStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  running: '响应中',
  waiting_permission: '等待授权',
  cancelling: '正在停止',
  error: '会话出错',
};
const toolLabels: Record<string, string> = {
  pending: '待执行',
  in_progress: '执行中',
  completed: '已执行',
  failed: '执行失败',
  cancelled: '已取消',
  history_truncated: '历史已截断',
  '已响应 · end_turn': '已响应',
  '已响应 · max_tokens': '达到本轮输出上限',
  '已响应 · max_turn_requests': '达到本轮操作上限',
  '已响应 · refusal': 'Agent 拒绝执行',
};

export function AcpApp({ model, send }: Props) {
  const { record, status } = model;
  const binding = record.binding;
  const [profileId, setProfileId] = useState(record.profileId ?? model.profiles[0]?.id ?? '');
  const [draft, setDraft] = useState(model.draft);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ text: string; messageIds: Set<string>; status: AcpStatus; updatedAt: string }>();
  const draftRef = useRef(draft);
  const draftRevision = useRef(model.draftRevision);
  const draftVersion = useRef(model.draftVersion);
  const acceptedDraftRevision = useRef(model.draftRevision);
  const savedDraft = useRef({ version: model.draftVersion, revision: model.draftRevision });
  const conversation = useRef(record.id);
  const sendRef = useRef(send);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const followOutput = useRef(true);
  sendRef.current = send;

  // An error may leave an agent waiting for login or cancellation. Keep disconnect reachable.
  const hasConnection = status !== 'disconnected';
  const controls = hasConnection ? model.controls : undefined;
  const busy =
    model.sending || !!controls?.configuring || status === 'connecting' || status === 'running' || status === 'waiting_permission' || status === 'cancelling';
  const canChooseProfile = !record.profileId && !record.sessionId && !hasConnection && !busy && !sending;
  const availableProfile = model.profiles.some((profile) => profile.id === profileId);
  const needsRestore = !!record.sessionId && !hasConnection;
  const canSend = !!draft.trim() && availableProfile && !busy && !sending && !pending && !needsRestore && status !== 'error';
  const canStop = status === 'running' || status === 'waiting_permission' || status === 'cancelling';
  const lastMessage = record.messages.at(-1);

  const flushDraft = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const version = draftVersion.current;
    const revision = draftRevision.current;
    if (version !== savedDraft.current.version || revision !== savedDraft.current.revision) {
      savedDraft.current = { version, revision };
      sendRef.current({ type: 'draft', text: draftRef.current, version, revision });
    }
  };
  const scheduleDraft = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(flushDraft, 300);
  };

  useEffect(() => {
    const staleDraft = model.draftVersion < draftVersion.current || model.draftRevision < acceptedDraftRevision.current;
    if (!staleDraft && conversation.current !== record.id) {
      conversation.current = record.id;
      setSending(false);
      setPending(undefined);
      setProfileId(record.profileId ?? model.profiles[0]?.id ?? '');
      followOutput.current = true;
    }
    // Drafts belong to the task, including edits made while a new conversation is being created.
    if (!staleDraft) {
      acceptedDraftRevision.current = model.draftRevision;
      if (model.draftRevision >= draftRevision.current) {
        // Canonical empty drafts also acknowledge completion when a panel was reopened mid-turn.
        clearTimeout(timer.current);
        timer.current = undefined;
        draftRef.current = model.draft;
        draftRevision.current = model.draftRevision;
        savedDraft.current = { version: model.draftVersion, revision: model.draftRevision };
      } else {
        // Merge host changes into newer local edits without replaying already applied context.
        for (const change of model.draftChanges) {
          if (change.version <= draftVersion.current || change.version > model.draftVersion) continue;
          if (change.type === 'append') draftRef.current = [draftRef.current, change.text].filter(Boolean).join('\n\n');
          else if (draftRevision.current <= change.revision) draftRef.current = '';
        }
      }
      draftVersion.current = model.draftVersion;
      setDraft(draftRef.current);
      if (!timer.current && (savedDraft.current.version !== draftVersion.current || savedDraft.current.revision !== draftRevision.current)) scheduleDraft();
    }
    if (pending) {
      const sent = record.messages.find((item) => item.role === 'user' && !pending.messageIds.has(item.id) && item.text === pending.text);
      if (model.error || (!busy && record.interrupted)) {
        setPending(undefined);
        setSending(false);
      } else if (sent && !sent.uncertain && status === 'connected' && !model.sending) {
        setPending(undefined);
        setSending(false);
      } else if (status !== pending.status || record.updatedAt !== pending.updatedAt) setSending(false);
    }
  }, [model]);

  useEffect(() => {
    if (record.profileId) setProfileId(record.profileId);
  }, [record.profileId]);

  useEffect(() => {
    if (!profileId && model.profiles.length) setProfileId(model.profiles[0]!.id);
  }, [profileId, model.profiles]);

  useEffect(() => {
    if (transcript.current && followOutput.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [record.id, record.messages.length, lastMessage?.id, lastMessage?.text]);

  useEffect(() => () => flushDraft(), []);

  const updateDraft = (text: string) => {
    ++draftRevision.current;
    draftRef.current = text;
    setDraft(text);
    scheduleDraft();
  };
  const commandDraft = (name: string, inputHint?: string) => `/${name}${draftRef.current ? ` ${draftRef.current}` : inputHint ? ' ' : ''}`;
  const submit = () => {
    if (!canSend) return;
    flushDraft();
    setPending({
      text: draftRef.current,
      messageIds: new Set(record.messages.map((item) => item.id)),
      status,
      updatedAt: record.updatedAt,
    });
    setSending(true);
    send({ type: 'send', text: draftRef.current, profileId, version: draftVersion.current, revision: draftRevision.current });
  };

  return (
    <main className="acp-app">
      <header className="acp-header">
        <div className="acp-heading">
          <h1>{binding.title} · Agent 对话</h1>
          <span className="acp-status" role="status" aria-live="polite">
            {statusLabels[status]}
          </span>
        </div>
        <p className="path">工作区：{binding.workspace}</p>
        <details className="acp-context">
          <summary>仓库与分支</summary>
          <p className="path">主目录：{binding.repository}</p>
          <p className="path">任务分支：{binding.branch}</p>
        </details>
        <div className="acp-profile">
          <label className="field">
            Agent
            <NativeSelect aria-label="Agent 配置" value={profileId} disabled={!canChooseProfile} onChange={(event) => setProfileId(event.target.value)}>
              {!model.profiles.length && <NativeSelectOption value="">尚未配置 Agent</NativeSelectOption>}
              {!!profileId && !availableProfile && <NativeSelectOption value={profileId}>配置已移除：{profileId}</NativeSelectOption>}
              {model.profiles.map((profile) => (
                <NativeSelectOption key={profile.id} value={profile.id}>
                  {profile.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <Button variant="secondary" size="sm" onClick={() => send({ type: 'configure' })}>
            配置 Agent
          </Button>
          <Button variant="secondary" size="sm" onClick={() => send({ type: 'review' })}>
            查看任务差异
          </Button>
        </div>
        {record.agentName && <p className="muted">当前 Agent：{record.agentName}</p>}
        {controls?.title && <p className="muted acp-message-text">Agent 会话：{controls.title}</p>}
        {controls && (controls.configOptions !== undefined || controls.modes) && (
          <section className="acp-session-settings" aria-label="会话配置" aria-busy={controls.configuring}>
            {controls.configOptions !== undefined ? (
              controls.configOptions.map((option) =>
                option.type === 'boolean' ? (
                  <label className="acp-config-toggle" key={option.id}>
                    <Checkbox
                      aria-label={option.name}
                      checked={option.currentValue}
                      disabled={busy || sending || status !== 'connected'}
                      onCheckedChange={(checked) => send({ type: 'set-config', configId: option.id, value: checked === true })}
                    />
                    <span>
                      {option.name}
                      {option.description && <span className="muted acp-control-description">{option.description}</span>}
                    </span>
                  </label>
                ) : (
                  <label className="field" key={option.id}>
                    {option.name}
                    <NativeSelect
                      aria-label={option.name}
                      value={option.currentValue}
                      disabled={busy || sending || status !== 'connected'}
                      onChange={(event) => send({ type: 'set-config', configId: option.id, value: event.target.value })}
                    >
                      <ConfigValues options={option.options} />
                    </NativeSelect>
                    {option.description && <span className="muted acp-control-description">{option.description}</span>}
                  </label>
                ),
              )
            ) : (
              <label className="field">
                会话模式
                <NativeSelect
                  aria-label="会话模式"
                  value={controls.modes!.currentModeId}
                  disabled={busy || sending || status !== 'connected'}
                  onChange={(event) => send({ type: 'set-mode', modeId: event.target.value })}
                >
                  {controls.modes!.availableModes.map((mode) => (
                    <NativeSelectOption key={mode.id} value={mode.id} title={mode.description}>
                      {mode.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            )}
            {controls.configuring && (
              <p className="muted" role="status">
                正在应用配置…
              </p>
            )}
          </section>
        )}
        {controls?.usage && (
          <p className="muted acp-usage" aria-label="会话用量">
            上下文：{controls.usage.used.toLocaleString('zh-CN')} / {controls.usage.size.toLocaleString('zh-CN')} tokens
            {controls.usage.cost &&
              ` · 累计费用：${controls.usage.cost.amount.toLocaleString('zh-CN', { maximumFractionDigits: 6 })} ${controls.usage.cost.currency}`}
          </p>
        )}
        <div className="actions acp-session-actions">
          {!hasConnection && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!availableProfile || busy || sending || (needsRestore && !record.canLoad)}
              onClick={() => send({ type: 'connect', profileId, resume: needsRestore })}
            >
              {needsRestore ? '继续会话' : '连接 Agent'}
            </Button>
          )}
          {hasConnection && (
            <Button variant="secondary" size="sm" onClick={() => send({ type: 'disconnect' })}>
              {busy || status === 'error' ? '结束 Agent 进程' : '断开连接'}
            </Button>
          )}
          {(record.profileId || record.sessionId || record.messages.length > 0) && (
            <Button variant="secondary" size="sm" disabled={busy || sending} onClick={() => send({ type: 'new' })}>
              新建会话
            </Button>
          )}
        </div>
      </header>

      {!model.profiles.length && <p className="notice">先配置支持 ACP 的 Agent，再发送任务说明。配置入口位于上方。</p>}
      {needsRestore && (
        <p className="notice">
          {record.canLoad ? '已有会话尚未连接。请选择「继续会话」，或新建会话重新开始。' : '此 Agent 未声明支持恢复旧会话。可以查看记录，或新建会话继续。'}
        </p>
      )}
      {record.interrupted && !busy && <p className="notice">上次执行已中断，现有文件改动会保留。请先查看会话和任务差异，再决定如何继续。</p>}
      {model.error && (
        <div className="error" role="alert">
          {model.error}
        </div>
      )}
      {!!controls?.notices.length && (
        <section aria-label="会话通知" className="acp-notices">
          {controls.notices.map((notice) => (
            <div className={notice.severity === 'error' ? 'error' : 'notice'} key={notice.id} role={notice.severity === 'error' ? 'alert' : 'status'}>
              <strong className="acp-message-text">{notice.title}</strong>
              {notice.description && <p className="acp-message-text">{notice.description}</p>}
            </div>
          ))}
        </section>
      )}
      {!!model.authMethods.length && (status === 'error' || !record.sessionId) && (
        <section className="notice acp-auth" aria-label="Agent 登录">
          <h2>登录 Agent</h2>
          {model.authMethods.map((method) => (
            <div key={method.id}>
              {method.description && <p className="acp-message-text">{method.description}</p>}
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => send({ type: 'authenticate', methodId: method.id })}>
                {method.name}
              </Button>
            </div>
          ))}
        </section>
      )}

      <div
        className="acp-transcript"
        ref={transcript}
        role="log"
        aria-label="任务对话记录"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={() => {
          const element = transcript.current;
          if (element) followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {record.messages.length ? (
          record.messages.map((message) => <Message key={message.id} message={message} />)
        ) : (
          <div className="acp-empty muted">
            <p>在此发送任务说明，Agent 将在上方工作区中执行。</p>
            <p>打开对话不会启动 Agent；发送消息或连接后才会启动。</p>
          </div>
        )}
      </div>

      {!!model.permissions.length && (
        <section className="acp-permissions" aria-label="待处理的授权">
          {model.permissions.map((permission) => (
            <Permission key={permission.id} permission={permission} task={binding.title} workspace={binding.workspace} status={status} send={send} />
          ))}
        </section>
      )}

      <form
        className="acp-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {!!controls?.commands.length && (
          <details className="acp-commands">
            <summary>Agent 命令</summary>
            <p className="muted">选择命令后会加入消息草稿。</p>
            <div className="acp-command-list">
              {controls.commands.map((command) => (
                <div key={command.name}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy || sending || commandDraft(command.name, command.inputHint).length > 100_000}
                    onClick={() => {
                      updateDraft(commandDraft(command.name, command.inputHint));
                      composer.current?.focus();
                    }}
                  >
                    /{command.name}
                  </Button>
                  <span className="muted acp-message-text">
                    {command.description}
                    {command.inputHint ? ` · ${command.inputHint}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
        <label className="field">
          消息
          <Textarea
            ref={composer}
            value={draft}
            maxLength={100_000}
            rows={5}
            placeholder="描述这项任务，或继续说明需要调整的地方…"
            onChange={(event) => updateDraft(event.target.value)}
            onBlur={flushDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="actions">
          <Button type="submit" disabled={!canSend}>
            {sending ? '正在发送…' : '发送'}
          </Button>
          {canStop && (
            <Button type="button" variant="secondary" disabled={status === 'cancelling'} onClick={() => send({ type: 'cancel' })}>
              {status === 'cancelling' ? '正在停止…' : '停止本轮'}
            </Button>
          )}
          <span className="muted">Ctrl / ⌘ + Enter 发送</span>
        </div>
      </form>
    </main>
  );
}

function ConfigValues({ options }: { options: Extract<AcpConfigOption, { type: 'select' }>['options'] }) {
  const groups: { label?: string; options: typeof options }[] = [];
  for (const option of options) {
    const previous = groups.at(-1);
    if (previous && previous.label === option.group) previous.options.push(option);
    else groups.push({ label: option.group, options: [option] });
  }
  return groups.map((group) => {
    const values = group.options.map((option) => (
      <NativeSelectOption key={option.value} value={option.value} title={option.description}>
        {option.name}
      </NativeSelectOption>
    ));
    return group.label === undefined ? (
      values
    ) : (
      <NativeSelectOptGroup key={group.options[0]!.value} label={group.label}>
        {values}
      </NativeSelectOptGroup>
    );
  });
}

function Message({ message }: { message: AcpMessage }) {
  const role = { user: '你', agent: 'Agent', thought: 'Agent 思考', tool: '操作记录', notice: '会话提示' }[message.role];
  const labels: Record<string, string> = message.compactionId
    ? { in_progress: '正在压缩', completed: '压缩完成', failed: '压缩失败', cancelled: '压缩已取消' }
    : toolLabels;
  return (
    <article className={`acp-message acp-message-${message.role}`}>
      <div className="acp-message-heading">
        <strong>{role}</strong>
        {message.status && <span className="muted">{labels[message.status] ?? message.status}</span>}
        {message.uncertain && <span className="acp-status">结果未确认</span>}
      </div>
      {message.role === 'thought' ? (
        <details className="acp-thought">
          <summary>查看思考过程</summary>
          <div className="acp-message-text">{message.text}</div>
        </details>
      ) : (
        <div className="acp-message-text">{message.text}</div>
      )}
    </article>
  );
}

function Permission({
  permission,
  task,
  workspace,
  status,
  send,
}: {
  permission: AcpPermission;
  task: string;
  workspace: string;
  status: AcpStatus;
  send: Props['send'];
}) {
  return (
    <div className="notice acp-permission">
      <h2>需要授权 · {permission.title}</h2>
      <p>任务：{task}</p>
      <p className="path">工作区：{workspace}</p>
      <div className="acp-message-text">{permission.detail}</div>
      <div className="actions">
        {permission.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.kind.startsWith('reject') ? 'secondary' : 'default'}
            disabled={status === 'cancelling' || status === 'disconnected' || status === 'error'}
            onClick={() => send({ type: 'permission', requestId: permission.id, optionId: option.id })}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
