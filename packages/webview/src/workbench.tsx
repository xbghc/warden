import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import type { WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { rebaseCheckLabels, rebaseResultLabels } from '@warden/shared';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import { AcpSetup } from './components/AcpSetup';
import { Checkbox } from './components/ui/checkbox';
import { Task, taskDraftKey } from './task';
import type { ViewState } from './task';
import { IconButton } from './components/ui/icon-button';
import { StatusBadge } from './components/ui/status-badge';

type Props = { model: WorkbenchModel; send(action: WorkbenchAction): void; state?: ViewState };
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
  if (model.agentConfiguration.status !== 'configured' || model.agentReadiness.status !== 'ready')
    return (
      <main className="setup">
        <AgentConfiguration model={model} send={send} compact={model.surface !== 'settings'} />
        {model.errors
          .filter((error) => model.surface === 'settings' && error.scope === 'agent')
          .map((error) => (
            <p className="error" role="alert" key={error.message}>
              {error.message}
            </p>
          ))}
      </main>
    );
  if (model.repositoryState === 'loading')
    return (
      <main>
        <p className="muted" role="status">
          Opening repository…
        </p>
      </main>
    );
  const scope = model.surface === 'task' ? `task:${model.task?.id ?? 'new'}` : model.surface;
  return (
    <main className={model.surface === 'task' ? 'task-pane' : undefined}>
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
        <Setup model={model} send={send} />
      ) : !model.workflow ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : !model.workflow.workflow && model.surface !== 'settings' ? (
        <Setup model={model} send={send} />
      ) : (
        <>
          {model.surface === 'task' && <Task key={taskDraftKey(model)} model={model} send={send} state={state} />}
          {model.surface === 'settings' && <Settings model={model} send={send} />}
          {model.surface === 'rebase' && <Rebase model={model} send={send} />}
        </>
      )}
    </main>
  );
}

function Setup({ model, send }: Props) {
  const repository = !!model.repository;
  return (
    <div className="setup">
      <p>{repository ? 'Select the base branch for this work.' : 'Select the Git repository containing the primary folder.'}</p>
      <Button disabled={!!model.busy} onClick={() => send({ type: repository ? 'setup.branch' : 'setup.repository' })}>
        {repository ? 'Select Base Branch' : 'Select Repository'}
      </Button>
    </div>
  );
}

function AgentConfiguration({ model, send, compact = false }: Props & { compact?: boolean }) {
  const configuration = model.agentConfiguration;
  const readiness = model.agentReadiness;
  const invalid = configuration.status === 'invalid';
  const checking = readiness.status === 'checking';
  if (compact) return <Button onClick={() => send({ type: 'setup.agents' })}>Configure ACP</Button>;
  return (
    <section aria-label="ACP">
      <h2>ACP</h2>
      {invalid ? (
        <p className="error" role="alert">
          Agent configuration is invalid. {configuration.message}
        </p>
      ) : (
        <p className="muted">
          {configuration.status === 'configured'
            ? `${configuration.count} agent profile${configuration.count === 1 ? '' : 's'} configured.`
            : 'Connect an agent that can receive messages in its assigned task workspace.'}
        </p>
      )}
      {configuration.status === 'configured' && (
        <>
          <p
            role={readiness.status === 'error' || readiness.status === 'authentication_required' ? 'alert' : 'status'}
            className={readiness.status === 'error' ? 'error' : 'muted'}
          >
            {readiness.profile && <strong>{readiness.profile.label}: </strong>}
            {readiness.message ?? 'ACP is disconnected.'}
          </p>
          <Button size="sm" onClick={() => send({ type: checking ? 'setup.cancelAgentCheck' : 'setup.checkAgent' })}>
            {checking
              ? 'Cancel Connection'
              : readiness.status === 'authentication_required' && readiness.authMethods?.length
                ? 'Authenticate Agent'
                : readiness.status === 'ready'
                  ? 'Reconnect ACP'
                  : 'Connect ACP'}
          </Button>{' '}
        </>
      )}
      <Button variant="secondary" size="sm" onClick={() => send({ type: 'settings.agents' })}>
        {invalid ? 'Fix Agent Configuration' : 'Choose Agent Preset'}
      </Button>
      <AcpSetup />
    </section>
  );
}

function Settings({ model, send }: Props) {
  const config = model.workflow?.workspaceConfig;
  const [initialize, setInitialize] = useState(config?.hooks.create ?? config?.hooks.reuse ?? '');
  const [setup, setSetup] = useState(config?.previewSetup ?? '');
  return (
    <div role="region" aria-label="Settings">
      <AgentConfiguration model={model} send={send} />
      <h2>Scripts</h2>
      <p className="path">{model.repository}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send({ type: 'settings.save', config: { hooks: { create: initialize, reuse: initialize }, previewSetup: setup } });
        }}
      >
        <label className="field">
          Workspace Setup Script
          <Textarea rows={4} value={initialize} onChange={(event) => setInitialize(event.target.value)} />
        </label>
        <p className="muted">Runs automatically when a task is added. Keep it safe to rerun; the workspace path is supplied through environment variables.</p>
        {config?.hooks.create !== config?.hooks.reuse && config?.hooks.reuse && (
          <details>
            <summary>Legacy Script Configuration</summary>
            <pre>{config.hooks.reuse}</pre>
            <p>Saving replaces the legacy configuration with the setup script above.</p>
          </details>
        )}
        <label className="field">
          Preview Setup Script
          <Textarea rows={4} value={setup} onChange={(event) => setSetup(event.target.value)} />
        </label>
        <p className="muted">Runs after preview initialization and content updates. Keep it safe to rerun, and keep dependencies and caches ignored by Git.</p>
        <Button type="submit" disabled={!!model.busy}>
          Save Script Configuration
        </Button>
      </form>
    </div>
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
    <div role="region" aria-label="Rebase">
      <div className="metadata branch" title="Rebase Target">
        <GitBranch aria-hidden="true" />
        <code>{model.workflow?.workflow?.developmentBranch}</code>
        <code className="muted">{model.workflow?.developmentHead?.slice(0, 8)}</code>
      </div>
      {(checks.length > 0 || retry) && (
        <div className="actions">
          <IconButton label="Check Again" disabled={!!model.busy} onClick={() => send({ type: 'rebase.check' })}>
            <RefreshCw aria-hidden="true" />
          </IconButton>
          {checks.length > 0 && (
            <>
              <label className="selection-toggle">
                <Checkbox
                  aria-label="Select All"
                  checked={selectedChecks.length === checks.length ? true : selectedChecks.length ? 'indeterminate' : false}
                  onCheckedChange={(checked) => setSelected(checked === true ? checks.map((check) => check.changeId) : [])}
                />
                Select all
              </label>
              <span className="muted" role="status">
                {selectedChecks.length} / {checks.length}
              </span>
            </>
          )}
        </div>
      )}
      {!model.checks && <p>Not Checked</p>}
      {model.checks && !checks.length && <p>No workspaces</p>}
      {checks.map((check) => (
        <label className="check" key={check.changeId}>
          <Checkbox
            aria-label={model.workflow?.workflow?.changes.find((task) => task.id === check.changeId)?.title ?? check.changeId}
            checked={selected.includes(check.changeId)}
            onCheckedChange={(checked) => setSelected(checked === true ? [...selected, check.changeId] : selected.filter((id) => id !== check.changeId))}
          />
          <div className="check-body">
            <strong>{model.workflow?.workflow?.changes.find((task) => task.id === check.changeId)?.title ?? check.changeId}</strong>
            <div className="metadata">
              <StatusBadge status={check.status}>{rebaseCheckLabels[check.status]}</StatusBadge>
              <time className="muted" dateTime={check.checkedAt} title="Checked at">
                {new Date(check.checkedAt).toLocaleTimeString('en-US')}
              </time>
            </div>
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
              Rebase Selected
            </Button>
          </div>
          <p className="muted">
            Only the selected workspaces will be rebased. Uncommitted changes, changed revisions and conflicts are reported for each workspace.
          </p>
        </>
      )}
      {model.rebaseResult && (
        <section>
          <h2>Results</h2>
          {model.rebaseResult.results.map((result) => (
            <div className="notice" key={result.changeId}>
              <div className="metadata">
                <strong>{model.workflow?.workflow?.changes.find((task) => task.id === result.changeId)?.title ?? result.changeId}</strong>
                <StatusBadge status={result.status}>{rebaseResultLabels[result.status]}</StatusBadge>
              </div>
              <p>{result.message}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
