import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { TaskNoteDraft, WorkbenchAction, WorkbenchModel } from '@warden/shared';
import { IconButton } from './components/ui/icon-button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';

export interface ViewState {
  read<T>(key: string, fallback: T): T;
  save(key: string, value: unknown): void;
}
type Draft = TaskNoteDraft;
export const taskDraftKey = (model: WorkbenchModel) => `task:v1:${model.repository}:${model.task?.id ?? 'none'}`;

/** The opt-in editor keeps a task's multiline notes and unsaved draft together. */
export function Task({ model, send, state }: { model: WorkbenchModel; send(action: WorkbenchAction): void; state: ViewState }) {
  const task = model.task;
  const key = taskDraftKey(model);
  const [draft, setDraft] = useState(() => state.read<Draft>(key, model.taskDraft ?? { title: task?.title ?? '', body: task?.body ?? '' }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const latest = useRef(draft);
  const persisted = useRef({ title: task?.title ?? '', body: task?.body ?? '' });
  // Follow edits saved elsewhere (another window or the sidebar) while this form has no
  // local changes, so a later save cannot write the previous values back.
  useEffect(() => {
    const next = { title: task?.title ?? '', body: task?.body ?? '' };
    const previous = persisted.current;
    persisted.current = next;
    if (latest.current.title === previous.title && latest.current.body === previous.body && (next.title !== previous.title || next.body !== previous.body)) {
      latest.current = next;
      setDraft(next);
    }
  }, [task?.title, task?.body]);
  const update = (patch: Partial<Draft>) => {
    const value = { ...latest.current, ...patch };
    latest.current = value;
    setDraft(value);
    setSaving(false);
    setSaved(false);
    state.save(key, value.title === task?.title && value.body === (task?.body ?? '') ? undefined : value);
    if (task) send({ type: 'task.draft', taskId: task.id, ...value });
  };
  useEffect(() => {
    if (saving && task?.title === draft.title && (task.body ?? '') === draft.body) {
      setSaving(false);
      setSaved(true);
      state.save(key, undefined);
    }
  }, [task?.title, task?.body, saving]);
  if (!task) return <p className="muted">Choose Edit Task from the task menu.</p>;
  const changed = draft.title !== task.title || draft.body !== (task.body ?? '');
  return (
    <section className="task-inline" aria-label="Edit Notes">
      <div className="task-section-heading">
        <h2>{task.title}</h2>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const submitted = { title: draft.title.trim(), body: draft.body.trim() };
          if (submitted.title !== draft.title || submitted.body !== draft.body) update(submitted);
          send({ type: 'task.update', taskId: task.id, ...submitted });
          setSaving(true);
        }}
      >
        <div className="field">
          <Input
            aria-label="Title"
            placeholder="Task title"
            required
            maxLength={200}
            value={draft.title}
            onChange={(event) => update({ title: event.target.value })}
          />
        </div>
        <div className="field">
          <Textarea
            aria-label="Notes"
            placeholder="Additional notes (optional)"
            rows={8}
            maxLength={10000}
            value={draft.body}
            onChange={(event) => update({ body: event.target.value })}
          />
        </div>
        <div className="actions">
          <IconButton label="Save Notes" variant="default" type="submit" disabled={!!model.busy || !changed || !draft.title.trim()}>
            <Check aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Discard Changes"
            disabled={!!model.busy || !changed}
            onClick={() => {
              setSaving(false);
              update({ title: task.title, body: task.body ?? '' });
            }}
          >
            <X aria-hidden="true" />
          </IconButton>
          {saved && (
            <span className="muted" role="status">
              Saved
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
