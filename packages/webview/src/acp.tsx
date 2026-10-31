import { useEffect, useId, useRef, useState } from 'react';
import { FileDiff, FolderOpen, MessageSquarePlus, Settings, Square, Unplug } from 'lucide-react';
import { AcpSetup } from './components/AcpSetup';
import type { AcpAction, AcpConfigOption, AcpMessage, AcpModel, AcpPermission, AcpStatus } from '@warden/shared';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './components/ui/native-select';
import { Textarea } from './components/ui/textarea';
import { IconButton } from './components/ui/icon-button';
import { StatusBadge } from './components/ui/status-badge';

type Props = { model: AcpModel; send(action: AcpAction): void };
const statusLabels: Record<AcpStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  running: 'Responding',
  waiting_permission: 'Permission Required',
  cancelling: 'Stopping',
  resetting: 'Starting New Session',
  error: 'Session Error',
};
const toolLabels: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  history_truncated: 'History Truncated',
  'Responded · end_turn': 'Responded',
  'Responded · max_tokens': 'Turn output limit reached',
  'Responded · max_turn_requests': 'Turn action limit reached',
  'Responded · refusal': 'Agent declined the request',
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
  const hasConnection = status !== 'disconnected' && status !== 'resetting';
  const controls = hasConnection ? model.controls : undefined;
  const configOptions = controls?.configOptions ?? [];
  const selectors = configOptions.filter((option) => option.type === 'select');
  const preferred = selectors.filter((option) => option.category === 'model' || option.category === 'mode');
  const primaryOptions = (preferred.length ? preferred : selectors).slice(0, 2);
  const primaryIds = new Set(primaryOptions.map((option) => option.id));
  const extraOptions = configOptions.filter((option) => !primaryIds.has(option.id));
  const busy =
    model.sending ||
    !!controls?.configuring ||
    status === 'connecting' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'cancelling' ||
    status === 'resetting';
  const canChooseProfile = !record.profileId && !record.sessionId && !hasConnection && !busy && !sending;
  const availableProfile = model.profiles.some((profile) => profile.id === profileId);
  const needsRestore = !!record.sessionId && status === 'disconnected';
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
          <h1>{binding.title}</h1>
          <span role="status" aria-live="polite">
            <StatusBadge status={status}>{statusLabels[status]}</StatusBadge>
          </span>
        </div>
        <p className="metadata path" aria-label="Workspace" title="Workspace">
          <FolderOpen aria-hidden="true" />
          <span>{binding.workspace}</span>
        </p>
        <details className="acp-context">
          <summary>Task and Session Info</summary>
          <p className="path">Primary folder: {binding.repository}</p>
          <p className="path">Task branch: {binding.branch}</p>
          {record.agentName && <p>Agent: {record.agentName}</p>}
          {controls?.title && <p className="acp-message-text">Agent session: {controls.title}</p>}
          {controls?.usage && (
            <p className="acp-usage" aria-label="Session Usage">
              Context: {controls.usage.used.toLocaleString('en-US')} / {controls.usage.size.toLocaleString('en-US')} tokens
              {controls.usage.cost &&
                ` · Total cost: ${controls.usage.cost.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${controls.usage.cost.currency}`}
            </p>
          )}
        </details>
        <div className="acp-profile">
          <div className="field">
            <NativeSelect aria-label="Agent Profile" value={profileId} disabled={!canChooseProfile} onChange={(event) => setProfileId(event.target.value)}>
              {!model.profiles.length && <NativeSelectOption value="">No agent profiles configured</NativeSelectOption>}
              {!!profileId && !availableProfile && <NativeSelectOption value={profileId}>Profile removed: {profileId}</NativeSelectOption>}
              {model.profiles.map((profile) => (
                <NativeSelectOption key={profile.id} value={profile.id}>
                  {profile.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <IconButton label="Configure Agent" size="icon-sm" onClick={() => send({ type: 'configure' })}>
            <Settings aria-hidden="true" />
          </IconButton>
          <IconButton label="View Task Diff" size="icon-sm" onClick={() => send({ type: 'review' })}>
            <FileDiff aria-hidden="true" />
          </IconButton>
        </div>
        {controls && (controls.configuring || (controls.configOptions !== undefined ? configOptions.length > 0 : controls.modes)) && (
          <section className="acp-session-settings" aria-label="Session Configuration" aria-busy={controls.configuring}>
            {controls.configOptions !== undefined ? (
              <>
                {!!primaryOptions.length && (
                  <div className="acp-config-row">
                    {primaryOptions.map((option) => (
                      <ConfigOption key={option.id} option={option} compact disabled={busy || sending || status !== 'connected'} send={send} />
                    ))}
                  </div>
                )}
                {!!extraOptions.length && (
                  <details className="acp-extra-options">
                    <summary>More Session Options · {extraOptions.length}</summary>
                    <div className="acp-config-row">
                      {extraOptions.map((option) => (
                        <ConfigOption key={option.id} option={option} disabled={busy || sending || status !== 'connected'} send={send} />
                      ))}
                    </div>
                  </details>
                )}
              </>
            ) : (
              controls.modes && (
                <label className="field">
                  Session Mode
                  <NativeSelect
                    aria-label="Session Mode"
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
              )
            )}
            {controls.configuring && (
              <p className="muted" role="status">
                Applying configuration…
              </p>
            )}
          </section>
        )}
        <div className="actions acp-session-actions">
          {!hasConnection && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!availableProfile || busy || sending || (needsRestore && !record.canLoad)}
              onClick={() => send({ type: 'connect', profileId, resume: needsRestore })}
            >
              {needsRestore ? 'Resume Session' : 'Connect Agent'}
            </Button>
          )}
          {hasConnection &&
            (busy || status === 'error' ? (
              <Button variant="secondary" size="sm" onClick={() => send({ type: 'disconnect' })}>
                End Agent Process
              </Button>
            ) : (
              <IconButton label="Disconnect" size="icon-sm" onClick={() => send({ type: 'disconnect' })}>
                <Unplug aria-hidden="true" />
              </IconButton>
            ))}
          {(record.profileId || record.sessionId || record.messages.length > 0) && (
            <IconButton label="New Session" size="icon-sm" disabled={busy || sending} onClick={() => send({ type: 'new' })}>
              <MessageSquarePlus aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </header>

      <AcpSetup />
      {needsRestore && (
        <p className="notice">
          {record.canLoad
            ? 'A previous session is disconnected. Resume it or start a new session.'
            : 'This agent does not advertise session restoration. View the saved history or start a new session.'}
        </p>
      )}
      {record.interrupted && !busy && (
        <p className="notice">
          The previous turn was interrupted. Existing file changes are preserved. Review the conversation and task diff before continuing.
        </p>
      )}
      {model.error && (
        <div className="error" role="alert">
          {model.error}
        </div>
      )}
      {!!controls?.notices.length && (
        <section aria-label="Session Notices" className="acp-notices">
          {controls.notices.map((notice) => (
            <div className={notice.severity === 'error' ? 'error' : 'notice'} key={notice.id} role={notice.severity === 'error' ? 'alert' : 'status'}>
              <strong className="acp-message-text">{notice.title}</strong>
              {notice.description && <p className="acp-message-text">{notice.description}</p>}
            </div>
          ))}
        </section>
      )}
      {!!model.authMethods.length && (status === 'error' || !record.sessionId) && (
        <section className="notice acp-auth" aria-label="Agent Authentication">
          <h2>Authenticate Agent</h2>
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
        aria-label="Conversation History"
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
            <p>Send task instructions here. The agent works in the workspace shown above.</p>
          </div>
        )}
      </div>

      {!!model.permissions.length && (
        <section className="acp-permissions" aria-label="Pending Permissions">
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
            <summary>Agent Commands</summary>
            <p className="muted">Choosing a command adds it to your message draft.</p>
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
        <div className="field">
          <Textarea
            aria-label="Message"
            ref={composer}
            value={draft}
            maxLength={100_000}
            rows={5}
            placeholder="Describe the task or explain what to change next…"
            onChange={(event) => updateDraft(event.target.value)}
            onBlur={flushDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div className="actions">
          <Button type="submit" disabled={!canSend} title="Send (Ctrl / ⌘ + Enter)" aria-keyshortcuts="Control+Enter Meta+Enter">
            {sending ? 'Sending…' : 'Send'}
          </Button>
          {canStop && (
            <IconButton
              label={status === 'cancelling' ? 'Stopping…' : 'Stop Turn'}
              size="icon"
              disabled={status === 'cancelling'}
              onClick={() => send({ type: 'cancel' })}
            >
              <Square aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </form>
    </main>
  );
}

function ConfigOption({ option, compact = false, disabled, send }: { option: AcpConfigOption; compact?: boolean; disabled: boolean; send: Props['send'] }) {
  const descriptionId = useId();
  const description = option.description && (
    <span id={descriptionId} className={compact ? 'sr-only' : 'muted acp-control-description'}>
      {option.description}
    </span>
  );
  return option.type === 'boolean' ? (
    <label className="acp-config-toggle">
      <Checkbox
        aria-label={option.name}
        aria-describedby={option.description ? descriptionId : undefined}
        checked={option.currentValue}
        disabled={disabled}
        onCheckedChange={(checked) => send({ type: 'set-config', configId: option.id, value: checked === true })}
      />
      <span>
        {option.name}
        {description}
      </span>
    </label>
  ) : (
    <label className="field">
      {option.name}
      <NativeSelect
        aria-label={option.name}
        aria-describedby={option.description ? descriptionId : undefined}
        title={option.description}
        value={option.currentValue}
        disabled={disabled}
        onChange={(event) => send({ type: 'set-config', configId: option.id, value: event.target.value })}
      >
        <ConfigValues options={option.options} />
      </NativeSelect>
      {description}
    </label>
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
  const role = { user: 'You', agent: 'Agent', thought: 'Agent Thoughts', tool: 'Activity', notice: 'Session Notice' }[message.role];
  const labels: Record<string, string> = message.compactionId
    ? { in_progress: 'Compacting', completed: 'Compaction Complete', failed: 'Compaction Failed', cancelled: 'Compaction Cancelled' }
    : toolLabels;
  return (
    <article className={`acp-message acp-message-${message.role}`}>
      <div className="acp-message-heading">
        <strong>{role}</strong>
        {message.status && <span className="muted">{labels[message.status] ?? message.status}</span>}
        {message.uncertain && <StatusBadge status="uncertain">Outcome Unknown</StatusBadge>}
      </div>
      {message.role === 'thought' ? (
        <details className="acp-thought">
          <summary>Show Thoughts</summary>
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
      <h2>Permission Required · {permission.title}</h2>
      <p>Task: {task}</p>
      <p className="path">Workspace: {workspace}</p>
      <div className="acp-message-text">{permission.detail}</div>
      <div className="actions">
        {permission.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.kind.startsWith('reject') ? 'secondary' : 'default'}
            disabled={status === 'cancelling' || status === 'disconnected' || status === 'resetting' || status === 'error'}
            onClick={() => send({ type: 'permission', requestId: permission.id, optionId: option.id })}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
