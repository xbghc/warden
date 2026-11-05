import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Info,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRight,
  ShieldQuestion,
  Square,
} from 'lucide-react';
import type { AcpAction, AcpConfigOption, AcpMessage, AcpModel, AcpPermission, AcpStatus } from '@warden/shared';
import { Button } from './components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './components/ui/select';
import { Textarea } from './components/ui/textarea';
import { IconButton } from './components/ui/icon-button';
import { StatusBadge } from './components/ui/status-badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { ChatMarkdown, CopyText } from './chat-markdown';
import { completeSlashCommand, slashCommandQuery } from './chat-commands';

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
  const commandList = useRef<HTMLDivElement>(null);
  const commandListId = useId();
  const [composerFocused, setComposerFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [selection, setSelection] = useState({ text: '', start: 0, end: 0 });
  const [dismissedCommand, setDismissedCommand] = useState<string>();
  const [commandIndex, setCommandIndex] = useState(0);
  const followOutput = useRef(model.viewState?.followOutput ?? true);
  sendRef.current = dispatch;
  profileRef.current = profileId;

  // Errors can leave an agent process alive; Settings › Agent Processes ends it outside the chat.
  const hasConnection = status !== 'disconnected' && status !== 'resetting';
  const controls = hasConnection ? model.controls : undefined;
  const configOptions = controls?.configOptions ?? [];
  const selectors = configOptions.filter((option) => option.type === 'select');
  const preferred = ['mode', 'model', 'thought_level'].flatMap((category) => selectors.find((option) => option.category === category) ?? []);
  const primaryOptions = preferred.length ? preferred : selectors.slice(0, 3);
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
  const configMode = controls?.configOptions !== undefined ? primaryOptions.find((option) => option.category === 'mode') : undefined;
  // Mirror the footer: config options replace legacy modes whenever the agent advertises them.
  const modeValues =
    configMode?.type === 'select'
      ? { current: configMode.currentValue, values: configMode.options.map((option) => option.value) }
      : controls?.configOptions === undefined && controls?.modes
        ? { current: controls.modes.currentModeId, values: controls.modes.availableModes.map((mode) => mode.id) }
        : undefined;
  const cycleMode = () => {
    if (!modeValues || modeValues.values.length < 2 || busy || sending || status !== 'connected') return;
    const next = modeValues.values[(modeValues.values.indexOf(modeValues.current) + 1) % modeValues.values.length]!;
    if (configMode) send({ type: 'set-config', configId: configMode.id, value: next });
    else send({ type: 'set-mode', modeId: next });
  };
  const needsRestore = !!record.sessionId && status === 'disconnected';
  const canSend = !!draft.trim() && availableProfile && !busy && !sending && !pending && !(needsRestore && !record.canLoad) && status !== 'error';
  const canStop = status === 'running' || status === 'waiting_permission' || status === 'cancelling';
  const lastUser = record.messages.filter((message) => message.role === 'user').at(-1);
  const submitted =
    model.sending && canStop && model.submittedDraft?.version === draftVersion.current && model.submittedDraft?.revision === draftRevision.current;
  const composerText = submitted ? '' : draft;
  const commandQuery =
    composerFocused && !switching && !composing && selection.text === composerText
      ? slashCommandQuery(composerText, selection.start, selection.end)
      : undefined;
  const commandKey = `${record.id}:${composerText}:${selection.start}`;
  const matchingCommands =
    commandQuery && dismissedCommand !== commandKey
      ? (controls?.commands ?? []).filter((command) => command.name.toLowerCase().startsWith(commandQuery.query))
      : [];
  const activeCommandIndex = Math.min(commandIndex, matchingCommands.length - 1);
  const activeCommand = matchingCommands[activeCommandIndex];
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
    const input = composer.current;
    if (input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      setSelection({ text: input.value, start: input.value.length, end: input.value.length });
    }
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
      // Agents without system prompts receive visible workspace context appended to the stored text.
      const sent = record.messages.find((item) => item.role === 'user' && !pending.messageIds.has(item.id) && item.text.startsWith(pending.text));
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

  useEffect(() => setCommandIndex(0), [commandKey]);
  useLayoutEffect(() => {
    commandList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeCommand?.name]);

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
  const readSelection = (input: HTMLTextAreaElement) => setSelection({ text: input.value, start: input.selectionStart, end: input.selectionEnd });
  const chooseCommand = (name: string) => {
    if (!commandQuery) return false;
    const completed = completeSlashCommand(composerText, commandQuery.tokenEnd, name);
    if (!completed) return false;
    updateDraft(completed.text);
    requestAnimationFrame(() => {
      if (switchingRef.current || draftRef.current !== completed.text) return;
      composer.current?.focus({ preventScroll: true });
      composer.current?.setSelectionRange(completed.caret, completed.caret);
    });
    return true;
  };
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
                <DropdownMenuItem onSelect={() => setShowInfo(!showInfo)}>
                  <Info aria-hidden="true" />
                  {showInfo ? 'Info: Hide' : 'Info: Show'}
                </DropdownMenuItem>
                {(record.profileId || record.sessionId || record.messages.length > 0) && (
                  <DropdownMenuItem disabled={busy || sending} onSelect={() => send({ type: 'new' })}>
                    <MessageSquarePlus aria-hidden="true" />
                    New Session
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
            {record.messages.length
              ? activityRows(record.messages).map((messages) =>
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
              : null}
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
        {controls?.configuring && (
          <p className="acp-composer-status muted" role="status">
            Applying configuration…
          </p>
        )}
        <div className="acp-input-box">
          {!!matchingCommands.length && (
            <div ref={commandList} id={commandListId} role="listbox" aria-label="Agent Commands" className="acp-command-menu">
              {matchingCommands.map((command, index) => (
                <Button
                  key={command.name}
                  id={`${commandListId}-${index}`}
                  type="button"
                  variant="ghost"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeCommandIndex}
                  disabled={!completeSlashCommand(composerText, commandQuery!.tokenEnd, command.name)}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => setCommandIndex(index)}
                  onClick={() => chooseCommand(command.name)}
                >
                  <span>/{command.name}</span>
                  <span className="muted acp-control-description">
                    {command.description}
                    {command.inputHint ? ` · ${command.inputHint}` : ''}
                  </span>
                </Button>
              ))}
            </div>
          )}
          <Textarea
            aria-label="Message"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls={matchingCommands.length ? commandListId : undefined}
            aria-activedescendant={activeCommand ? `${commandListId}-${activeCommandIndex}` : undefined}
            ref={composer}
            value={composerText}
            maxLength={100_000}
            rows={3}
            disabled={switching}
            placeholder={model.permissions.length ? 'Write a follow-up…' : canStop ? 'Write a follow-up while the agent works…' : 'Describe what to work on…'}
            onChange={(event) => {
              updateDraft(event.target.value);
              readSelection(event.target);
              setDismissedCommand(undefined);
            }}
            onSelect={(event) => readSelection(event.currentTarget)}
            onFocus={(event) => {
              readSelection(event.target);
              setComposerFocused(true);
            }}
            onBlur={() => {
              setComposerFocused(false);
              flushDraft();
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              readSelection(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (matchingCommands.length && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCommandIndex((activeCommandIndex + (event.key === 'ArrowDown' ? 1 : -1) + matchingCommands.length) % matchingCommands.length);
                  return;
                }
                if ((event.key === 'Enter' || event.key === 'Tab') && activeCommand) {
                  const completed = chooseCommand(activeCommand.name);
                  if (completed || event.key === 'Enter') event.preventDefault();
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDismissedCommand(commandKey);
                  return;
                }
              }
              // Tab stays inside the composer while a mode selector exists, even when a pending change
              // ignores it, so repeated presses never jump focus. Shift+Tab keeps native focus navigation.
              if (event.key === 'Tab' && modeValues && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                cycleMode();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
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
                    <ComposerPicker
                      key={option.id}
                      name={option.name}
                      description={option.description}
                      category={option.category}
                      value={option.currentValue}
                      options={option.options}
                      disabled={busy || sending || status !== 'connected'}
                      onValueChange={(value) => send({ type: 'set-config', configId: option.id, value })}
                      onSelected={() => composer.current?.focus({ preventScroll: true })}
                    />
                  ))
                : controls?.modes && (
                    <ComposerPicker
                      name="Session Mode"
                      category="mode"
                      value={controls.modes.currentModeId}
                      options={controls.modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description }))}
                      disabled={busy || sending || status !== 'connected'}
                      onValueChange={(modeId) => send({ type: 'set-mode', modeId })}
                      onSelected={() => composer.current?.focus({ preventScroll: true })}
                    />
                  )}
            </div>
            {canStop ? (
              <IconButton
                label={status === 'cancelling' ? 'Stopping…' : 'Stop Turn'}
                size="icon-sm"
                className="acp-submit"
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
                className="acp-submit"
                disabled={!canSend}
                title="Send (Enter); Shift+Enter for a new line"
                aria-keyshortcuts="Enter Control+Enter Meta+Enter"
              >
                <ArrowUp aria-hidden="true" />
              </IconButton>
            )}
          </div>
        </div>
      </form>
    </main>
  );
}

type SelectOptions = Extract<AcpConfigOption, { type: 'select' }>['options'];

function groupConfigValues(options: SelectOptions) {
  const groups: { label?: string; options: typeof options }[] = [];
  for (const option of options) {
    const previous = groups.at(-1);
    if (previous && previous.label === option.group) previous.options.push(option);
    else groups.push({ label: option.group, options: [option] });
  }
  return groups;
}

function ComposerPicker({
  name,
  description,
  category,
  value,
  options,
  disabled,
  onValueChange,
  onSelected,
}: {
  name: string;
  description?: string;
  category?: string;
  value: string;
  options: SelectOptions;
  disabled: boolean;
  onValueChange(value: string): void;
  onSelected?(): void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = useRef(false);
  const descriptionId = useId();
  const selected = options.find((option) => option.value === value);
  // A configuration request or a new turn invalidates an already open picker.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <Select
      value={value}
      disabled={disabled}
      open={open && !disabled}
      onOpenChange={setOpen}
      onValueChange={(value) => {
        chosen.current = true;
        onValueChange(value);
      }}
    >
      <SelectTrigger
        className="acp-picker"
        data-category={category}
        aria-label={name}
        aria-describedby={description ? descriptionId : undefined}
        title={`${name}: ${selected?.name ?? value}${description ? ` — ${description}` : ''}`}
      >
        <SelectValue>{selected?.name ?? value}</SelectValue>
      </SelectTrigger>
      {description && (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      )}
      <SelectContent
        className="acp-picker-menu"
        aria-label={name}
        onCloseAutoFocus={(event) => {
          // The trigger becomes disabled while the agent confirms the choice; keep typing reachable.
          if (chosen.current && onSelected) {
            event.preventDefault();
            onSelected();
          }
          chosen.current = false;
        }}
      >
        <SelectGroup>
          <SelectLabel>{name}</SelectLabel>
          {groupConfigValues(options).map((group) => (
            <SelectGroup key={group.options[0]!.value}>
              {group.label !== undefined && <SelectLabel>{group.label}</SelectLabel>}
              {group.options.map((option) => (
                <SelectItem key={option.value} value={option.value} textValue={option.name} description={option.description}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
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
      // Alignment and styling distinguish user and agent messages; only notices keep a visible label.
      <article className={`acp-message acp-message-${message.role}`} aria-label={role}>
        <div className="acp-message-heading">
          {message.role === 'notice' && <strong>{role}</strong>}
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
