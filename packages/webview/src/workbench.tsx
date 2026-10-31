import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import type { WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { rebaseCheckLabels, rebaseResultLabels } from '@warden/shared';
import { Button } from './components/ui/button';
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
  if (model.agentConfiguration.status !== 'configured' || model.agentReadiness.status !== 'ready' || model.surface === 'settings')
    return (
      <main className="setup">
        <Button onClick={() => send({ type: 'setup.agents' })}>{model.agentReadiness.status === 'ready' ? 'Open Settings' : 'Configure ACP'}</Button>
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
      ) : !model.workflow.workflow ? (
        <Setup model={model} send={send} />
      ) : (
        <>
          {model.surface === 'task' && <Task key={taskDraftKey(model)} model={model} send={send} state={state} />}
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
          <IconButton label="Check Again" disabled={!!model.busy || model.checkingRebase} onClick={() => send({ type: 'rebase.check' })}>
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
      {model.checkingRebase && <p role="status">Checking synchronization…</p>}
      {!model.checks && !model.checkingRebase && <p>Not Checked</p>}
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
              {!model.checkingRebase && (
                <time className="muted" dateTime={check.checkedAt} title="Checked at">
                  {new Date(check.checkedAt).toLocaleTimeString('en-US')}
                </time>
              )}
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
              disabled={!!model.busy || model.checkingRebase || !selectedChecks.length}
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
