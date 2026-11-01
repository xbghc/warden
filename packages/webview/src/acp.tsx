import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FileDiff,
  FileText,
  Info,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRight,
  ShieldQuestion,
  SlidersHorizontal,
  Slash,
  Square,
  Unplug,
} from 'lucide-react';
import type { AcpAction, AcpConfigOption, AcpMessage, AcpModel, AcpPermission, AcpStatus } from '@warden/shared';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './components/ui/native-select';
import { Textarea } from './components/ui/textarea';
import { IconButton } from './components/ui/icon-button';
import { StatusBadge } from './components/ui/status-badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { ChatMarkdown, CopyText } from './chat-markdown';

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

export function AcpApp({ model, send: dispatch }: Props) {
  const { record, status } = model;
  const binding = record.binding;
  const profileId = record.profileId ?? model.defaultProfileId ?? '';
  const [showInfo, setShowInfo] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const switchingRef = useRef(false);
  const send = (action: AcpAction) => {
    if (!switchingRef.current) dispatch(action);
  };
  const openFile = useCallback(
    (reference: string) => {
      if (!switchingRef.current) dispatch({ type: 'open-file', reference });
    },
    [dispatch],
  );
  const [draft, setDraft] = useState(model.draft);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ text: string; messageIds: Set<string>; status: AcpStatus; updatedAt: string }>();
  const draftRef = useRef(draft);
  const draftRevision = useRef(model.draftRevision);
  const draftVersion = useRef(model.draftVersion);
  const acceptedDraftRevision = useRef(model.draftRevision);
  const savedDraft = useRef({ version: model.draftVersion, revision: model.draftRevision });
  const conversation = useRef(record.id);
  const sendRef = useRef(dispatch);
  const profileRef = useRef(profileId);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptContent = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const followOutput = useRef(model.viewState?.followOutput ?? true);
  sendRef.current = dispatch;
  profileRef.current = profileId;

  // An error may leave an agent waiting for login or cancellation. Keep disconnect reachable.
  const hasConnection = status !== 'disconnected' && status !== 'resetting';
  const controls = hasConnection ? model.controls : undefined;
  const configOptions = controls?.configOptions ?? [];
  const selectors = configOptions.filter((option) => option.type === 'select');
  const preferred = [...selectors.filter((option) => option.category === 'mode'), ...selectors.filter((option) => option.category === 'model')];
  const primaryOptions = (preferred.length ? preferred : selectors).slice(0, 2);
  const primaryIds = new Set(primaryOptions.map((option) => option.id));
  const extraOptions = configOptions.filter((option) => !primaryIds.has(option.id));
  const busy =
    switching ||
    model.sending ||
    !!controls?.configuring ||
    status === 'connecting' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'cancelling' ||
    status === 'resetting';
  const availableProfile = model.profiles.some((profile) => profile.id === profileId);
  const needsRestore = !!record.sessionId && status === 'disconnected';
  const canSend = !!draft.trim() && availableProfile && !busy && !sending && !pending && !(needsRestore && !record.canLoad) && status !== 'error';
  const canStop = status === 'running' || status === 'waiting_permission' || status === 'cancelling';
  const lastUser = record.messages.filter((message) => message.role === 'user').at(-1);
  const submitted =
    model.sending && canStop && model.submittedDraft?.version === draftVersion.current && model.submittedDraft?.revision === draftRevision.current;
  const composerText = submitted ? '' : draft;
  const working = status === 'connecting' || status === 'running' || status === 'cancelling' || status === 'resetting';
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

  useLayoutEffect(() => {
    if (transcript.current && !followOutput.current) transcript.current.scrollTop = model.viewState?.scrollTop ?? 0;
    composer.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const update = () => {
      const element = transcript.current;
      if (!element) return;
      if (followOutput.current) element.scrollTop = element.scrollHeight;
      setShowLatest(!followOutput.current && element.scrollHeight > element.clientHeight + 32);
    };
    const observer = new ResizeObserver(update);
    if (transcript.current) observer.observe(transcript.current);
    if (transcriptContent.current) observer.observe(transcriptContent.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (message?.panelId !== model.panelId) return;
      if (message.type === 'acp-resume') {
        switchingRef.current = false;
        setSwitching(false);
      } else if (message.type === 'acp-capture' && typeof message.requestId === 'string') {
        flushDraft();
        switchingRef.current = true;
        setSwitching(true);
        sendRef.current({
          type: 'view-state',
          requestId: message.requestId,
          scrollTop: transcript.current?.scrollTop ?? 0,
          followOutput: followOutput.current,
          profileId: profileRef.current,
        });
      }
    };
    window.addEventListener('message', receive);
    sendRef.current({ type: 'view-ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    const staleDraft = model.draftVersion < draftVersion.current || model.draftRevision < acceptedDraftRevision.current;
    if (!staleDraft && conversation.current !== record.id) {
      conversation.current = record.id;
      setSending(false);
      setPending(undefined);
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

  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
  }, [composerText]);

  useEffect(() => {
    if (transcript.current && followOutput.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [record.id, record.messages.length, lastMessage?.id, lastMessage?.text]);

  useEffect(() => () => flushDraft(), []);

  const updateDraft = (text: string) => {
    if (switchingRef.current) return;
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
    followOutput.current = true;
    setShowLatest(false);
    send({ type: 'send', text: draftRef.current, profileId, version: draftVersion.current, revision: draftRevision.current });
    composer.current?.focus({ preventScroll: true });
  };

  return (
    <main className={`acp-app${model.presentation === 'sidebar' ? ' acp-sidebar' : ''}`} aria-busy={switching}>
      <div className="acp-session">
        <header className="acp-header">
          <div className="acp-heading">
            <h1 title={binding.title}>{binding.title}</h1>
            <span className="acp-connection-status" role="status" aria-live="polite">
              {working && <LoaderCircle className="acp-spinner" aria-hidden="true" />}
              <StatusBadge status={status}>{statusLabels[status]}</StatusBadge>
            </span>
            <IconButton label="View Task Diff" size="icon-sm" disabled={switching} onClick={() => send({ type: 'review' })}>
              <FileDiff aria-hidden="true" />
            </IconButton>
            {model.presentation === 'editor' && (
              <IconButton label="Move Chat to Side Bar" size="icon-sm" disabled={switching} onClick={() => send({ type: 'open-sidebar' })}>
                <PanelRight aria-hidden="true" />
              </IconButton>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="More Chat Actions" size="icon-sm" disabled={switching}>
                  <MoreHorizontal aria-hidden="true" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={switching} onSelect={() => send({ type: 'insert-brief' })}>
                  <FileText aria-hidden="true" />
                  Insert Task Brief
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setShowInfo(!showInfo)}>
                  <Info aria-hidden="true" />
                  {showInfo ? 'Hide Task and Session Info' : 'Task and Session Info'}
                </DropdownMenuItem>
                {(record.profileId || record.sessionId || record.messages.length > 0) && (
                  <DropdownMenuItem disabled={busy || sending} onSelect={() => send({ type: 'new' })}>
                    <MessageSquarePlus aria-hidden="true" />
                    New Session
                  </DropdownMenuItem>
                )}
                {hasConnection && (
                  <DropdownMenuItem onSelect={() => send({ type: 'disconnect' })}>
                    <Unplug aria-hidden="true" />
                    {busy || status === 'error' ? 'End Agent Process' : 'Disconnect'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {showInfo && (
            <section className="acp-context" aria-label="Task and Session Info">
              <p className="path">Workspace: {binding.workspace}</p>
              <p className="path">Primary folder: {binding.repository}</p>
              <p className="path">Task branch: {binding.branch}</p>
              {(record.agentName || availableProfile) && <p>Agent: {record.agentName ?? model.profiles.find((profile) => profile.id === profileId)?.label}</p>}
              {controls?.title && <p className="acp-message-text">Agent session: {controls.title}</p>}
              {controls?.usage && (
                <p className="acp-usage" aria-label="Session Usage">
                  Context: {controls.usage.used.toLocaleString('en-US')} / {controls.usage.size.toLocaleString('en-US')} tokens
                  {controls.usage.cost &&
                    ` · Total cost: ${controls.usage.cost.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${controls.usage.cost.currency}`}
                </p>
              )}
            </section>
          )}
        </header>

        {!availableProfile && <p className="notice">Check the agent connection in the Warden workbench to continue.</p>}
        {needsRestore && (
          <p className="notice">
            {record.canLoad
              ? 'The session is disconnected. Sending a message or reopening this chat reconnects it.'
              : 'This agent does not advertise session restoration. View the saved history or start a new session.'}
          </p>
        )}
        {record.interrupted && !busy && (
          <p className="notice">
            The previous turn was interrupted. Existing file changes are preserved. Review the conversation and task diff before continuing.
          </p>
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
        {!!model.authMethods.length && status === 'error' && (
          <section className="notice acp-auth" aria-label="Agent Authentication">
            <h2>Authenticate Agent</h2>
            <p>Already signed in on this host? Reconnect to use the saved login.</p>
            <Button
              variant="secondary"
              size="sm"
              disabled={!availableProfile || busy || sending}
              onClick={() => send({ type: 'connect', profileId, resume: !!record.sessionId })}
            >
              I Have Signed In — Reconnect
            </Button>
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
      </div>

      {model.error && (
        <ChatError
          error={model.error}
          canRetry={availableProfile && (status === 'error' || status === 'disconnected') && !busy && !sending && !model.authMethods.length}
          retry={() => send({ type: 'connect', profileId, resume: !!record.sessionId })}
        />
      )}

      <div className="acp-history">
        <div
          className="acp-transcript"
          ref={transcript}
          role="log"
          aria-label="Conversation History"
          aria-live="polite"
          aria-relevant="additions"
          onScroll={() => {
            const element = transcript.current;
            if (element) {
              followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
              setShowLatest(!followOutput.current);
            }
          }}
        >
          <div className="acp-transcript-content" ref={transcriptContent}>
            {record.messages.length ? (
              activityRows(record.messages).map((messages) =>
                messages.length >= 3 ? (
                  <details className="acp-activity-group" key={messages[0]!.id}>
                    <summary>
                      <ChevronRight className="acp-disclosure" aria-hidden="true" />
                      {messages.length} earlier activities
                    </summary>
                    {messages.map((message) => (
                      <Message key={message.id} message={message} active={false} openFile={openFile} />
                    ))}
                  </details>
                ) : (
                  messages.map((message) => (
                    <Message key={message.id} message={message} active={model.sending && message.id === lastUser?.id} openFile={openFile} />
                  ))
                ),
              )
            ) : (
              <div className="acp-empty muted">
                <MessageSquare aria-hidden="true" />
                <h2>Work on this task</h2>
                <p>Describe the next step, or use the saved task brief.</p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={switching}
                  onClick={() => {
                    send({ type: 'insert-brief' });
                    composer.current?.focus();
                  }}
                >
                  <FileText aria-hidden="true" />
                  Use Task Brief
                </Button>
              </div>
            )}
          </div>
        </div>
        {showLatest && (
          <Button
            className="acp-jump"
            variant="secondary"
            size="sm"
            onClick={() => {
              followOutput.current = true;
              setShowLatest(false);
              if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
            }}
          >
            <ArrowDown aria-hidden="true" />
            Jump to Latest
          </Button>
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
        <div className="acp-input-box">
          <Textarea
            aria-label="Message"
            ref={composer}
            value={composerText}
            maxLength={100_000}
            rows={3}
            disabled={switching}
            placeholder={model.permissions.length ? 'Write a follow-up…' : canStop ? 'Write a follow-up while the agent works…' : 'Describe what to work on…'}
            onChange={(event) => updateDraft(event.target.value)}
            onBlur={flushDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="acp-composer-toolbar">
            <div className="acp-composer-tools" aria-label="Session Configuration" aria-busy={controls?.configuring}>
              {!hasConnection && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="acp-connect"
                  disabled={!availableProfile || busy || sending || (needsRestore && !record.canLoad)}
                  onClick={() => send({ type: 'connect', profileId, resume: !!record.sessionId })}
                >
                  Reconnect
                </Button>
              )}
              {controls?.configOptions !== undefined
                ? primaryOptions.map((option) => (
                    <ConfigOption key={option.id} option={option} compact disabled={busy || sending || status !== 'connected'} send={send} />
                  ))
                : controls?.modes && (
                    <div className="acp-picker">
                      <NativeSelect
                        aria-label="Session Mode"
                        title="Mode"
                        value={controls.modes.currentModeId}
                        disabled={busy || sending || status !== 'connected'}
                        onChange={(event) => send({ type: 'set-mode', modeId: event.target.value })}
                      >
                        {controls.modes.availableModes.map((mode) => (
                          <NativeSelectOption key={mode.id} value={mode.id} title={mode.description}>
                            {mode.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  )}
              {!!extraOptions.length && (
                <Popover>
                  <PopoverTrigger asChild>
                    <IconButton label="More Session Options" size="icon-sm" disabled={switching}>
                      <SlidersHorizontal aria-hidden="true" />
                    </IconButton>
                  </PopoverTrigger>
                  <PopoverContent side="top" className="acp-options-popover" aria-label="More Session Options">
                    {extraOptions.map((option) => (
                      <ConfigOption key={option.id} option={option} disabled={busy || sending || status !== 'connected'} send={send} />
                    ))}
                  </PopoverContent>
                </Popover>
              )}
              {!!controls?.commands.length && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton label="Agent Commands" size="icon-sm" disabled={busy || sending}>
                      <Slash aria-hidden="true" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="top"
                    align="start"
                    className="acp-command-menu"
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      composer.current?.focus();
                    }}
                  >
                    {controls.commands.map((command) => (
                      <DropdownMenuItem
                        key={command.name}
                        disabled={commandDraft(command.name, command.inputHint).length > 100_000}
                        onSelect={() => updateDraft(commandDraft(command.name, command.inputHint))}
                      >
                        <span>/{command.name}</span>
                        <span className="muted acp-control-description">
                          {command.description}
                          {command.inputHint ? ` · ${command.inputHint}` : ''}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {canStop ? (
              <IconButton
                label={status === 'cancelling' ? 'Stopping…' : 'Stop Turn'}
                size="icon-sm"
                disabled={status === 'cancelling'}
                onClick={() => send({ type: 'cancel' })}
              >
                <Square aria-hidden="true" />
              </IconButton>
            ) : (
              <IconButton
                label="Send"
                type="submit"
                variant="default"
                size="icon-sm"
                disabled={!canSend}
                title="Send (Enter); Shift+Enter for a new line"
                aria-keyshortcuts="Enter Control+Enter Meta+Enter"
              >
                <ArrowUp aria-hidden="true" />
              </IconButton>
            )}
          </div>
        </div>
        {controls?.configuring && (
          <p className="acp-composer-status muted" role="status">
            Applying configuration…
          </p>
        )}
        {!controls?.configuring && (
          <p className="acp-composer-hint muted">
            {canStop ? 'You can keep writing. Send when this turn finishes.' : 'Enter to send · Shift+Enter for a new line'}
          </p>
        )}
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
    <label className={compact ? 'acp-picker' : 'field'}>
      <span className={compact ? 'sr-only' : undefined}>{option.name}</span>
      <NativeSelect
        aria-label={option.name}
        aria-describedby={option.description ? descriptionId : undefined}
        title={option.description ? `${option.name}: ${option.description}` : option.name}
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

function ChatError({ error, canRetry, retry }: { error: string; canRetry: boolean; retry(): void }) {
  const summary = error.split('\n')[0]!.slice(0, 220);
  return (
    <section className="acp-error" role="alert">
      <div className="acp-error-summary">
        <p>{summary}</p>
        {canRetry && (
          <Button variant="secondary" size="sm" onClick={retry}>
            Reconnect
          </Button>
        )}
      </div>
      <details>
        <summary>Error Details</summary>
        <pre>{error}</pre>
        <CopyText text={error} label="Copy Error" />
      </details>
    </section>
  );
}

/** Keep failures, running tools and agent replies visible; only completed adjacent activity folds. */
function activityRows(messages: AcpMessage[]): AcpMessage[][] {
  const rows: AcpMessage[][] = [];
  const foldable = (message: AcpMessage) => message.role === 'thought' || (message.role === 'tool' && message.status === 'completed' && !message.compactionId);
  for (const message of messages) {
    const last = rows.at(-1);
    if (last && foldable(message) && foldable(last[0]!)) last.push(message);
    else rows.push([message]);
  }
  return rows;
}

const Message = memo(
  function Message({ message, active, openFile }: { message: AcpMessage; active: boolean; openFile(reference: string): void }) {
    const [expanded, setExpanded] = useState(false);
    const role = { user: 'You', agent: 'Agent', thought: 'Agent Thoughts', tool: 'Activity', notice: 'Session Notice' }[message.role];
    const labels: Record<string, string> = message.compactionId
      ? { in_progress: 'Compacting', completed: 'Compaction Complete', failed: 'Compaction Failed', cancelled: 'Compaction Cancelled' }
      : toolLabels;
    if (message.role === 'tool') {
      const [title, ...body] = message.text.split('\n');
      const unknown = message.uncertain && (message.status === 'pending' || message.status === 'in_progress');
      return (
        <article className="acp-message acp-message-tool">
          <details>
            <summary>
              <ChevronRight className="acp-disclosure" aria-hidden="true" />
              {message.status === 'in_progress' && !unknown ? (
                <LoaderCircle className="acp-spinner" aria-hidden="true" />
              ) : message.status === 'completed' ? (
                <Check aria-hidden="true" />
              ) : null}
              <span className="acp-tool-title">{title || 'Agent activity'}</span>
              <span className="acp-tool-status muted">
                <span>{unknown ? 'Outcome Unknown' : (labels[message.status ?? ''] ?? message.status)}</span>
                {message.exitCode !== undefined && <span>Exit {message.exitCode}</span>}
                {message.exitSignal && <span>Signal {message.exitSignal}</span>}
              </span>
            </summary>
            <div className="acp-tool-detail">
              {unknown && <p className="muted">The agent did not report a final outcome. Its command may still be running.</p>}
              <pre className="acp-message-text">{body.join('\n') || title}</pre>
              <CopyText text={message.text} label="Copy Activity" />
            </div>
          </details>
        </article>
      );
    }
    if (message.role === 'thought') {
      return (
        <article className="acp-message acp-message-thought">
          <details className="acp-thought">
            <summary>
              <ChevronRight className="acp-disclosure" aria-hidden="true" />
              Thoughts
            </summary>
            <ChatMarkdown text={message.text} openFile={openFile} />
          </details>
        </article>
      );
    }
    const longPrompt = message.role === 'user' && (message.text.length > 500 || message.text.split('\n').length > 8);
    return (
      <article className={`acp-message acp-message-${message.role}`}>
        <div className="acp-message-heading">
          <strong>{role}</strong>
          {active ? (
            <span className="muted">In progress</span>
          ) : message.uncertain ? (
            <StatusBadge status="uncertain">Outcome Unknown</StatusBadge>
          ) : (
            message.status && !message.status.startsWith('Responded') && <span className="muted">{labels[message.status] ?? message.status}</span>
          )}
          <CopyText text={message.text} />
        </div>
        <div className={`acp-message-text${longPrompt && !expanded ? ' acp-prompt-collapsed' : ''}`}>
          {message.role === 'agent' ? <ChatMarkdown text={message.text} openFile={openFile} /> : message.text}
        </div>
        {longPrompt && (
          <button className="acp-text-action" type="button" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show Less' : 'Show Full Message'}
          </button>
        )}
      </article>
    );
  },
  (previous, next) =>
    previous.active === next.active &&
    previous.openFile === next.openFile &&
    previous.message.text === next.message.text &&
    previous.message.role === next.message.role &&
    previous.message.status === next.message.status &&
    previous.message.exitCode === next.message.exitCode &&
    previous.message.exitSignal === next.message.exitSignal &&
    previous.message.uncertain === next.message.uncertain &&
    previous.message.compactionId === next.message.compactionId,
);

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
  let command = permission.command;
  let decodedCommand = false;
  // Some adapters JSON-encode the command string again inside rawInput. Decode one
  // display layer only; preserve shell escapes and the untouched raw request below.
  if (command?.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(command);
      if (typeof decoded === 'string') {
        command = decoded;
        decodedCommand = true;
      }
    } catch {
      // Ordinary shell quoting is displayed exactly as supplied.
    }
  }
  return (
    <div className="acp-permission">
      <h2>
        <ShieldQuestion aria-hidden="true" />
        {permission.title}
      </h2>
      <div className="acp-permission-context" role="region" aria-label="Permission Details" tabIndex={0}>
        <pre
          className="acp-permission-preview acp-message-text"
          aria-label={permission.command ? 'Requested Command' : 'Permission Request'}
          title={decodedCommand ? 'Decoded JSON preview. Original request in Details and Workspace.' : undefined}
        >
          {command ?? permission.detail}
        </pre>
        {decodedCommand && <p className="acp-permission-encoding muted">Decoded JSON preview. Original request in Details and Workspace.</p>}
        {permission.reason && <p className="acp-permission-reason">{permission.reason}</p>}
        {permission.cwd && <p className="acp-permission-cwd path">Working directory: {permission.cwd}</p>}
        <details className="acp-permission-details">
          <summary>Details and Workspace</summary>
          <p>Task: {task}</p>
          <p className="path">Workspace: {workspace}</p>
          <pre className="acp-message-text">{permission.detail}</pre>
        </details>
      </div>
      <div className="actions">
        {permission.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.kind === 'allow_once' ? 'default' : 'secondary'}
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
