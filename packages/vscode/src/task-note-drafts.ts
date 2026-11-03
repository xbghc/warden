import type { Memento } from 'vscode';
import type { TaskNoteDraft } from '@warden/shared';

const same = (left: TaskNoteDraft | undefined, right: TaskNoteDraft) => left?.title === right.title && left.body === right.body;

/** Keep editor drafts outside the disposable webview, without writing task records. */
export class TaskNoteDrafts {
  private readonly values = new Map<string, TaskNoteDraft | undefined>();
  private readonly deleted = new Set<string>();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly state: Memento) {}

  private key(repository: string, taskId: string) {
    return `warden.task-note-draft:${JSON.stringify([repository, taskId])}`;
  }

  read(repository: string, taskId: string): TaskNoteDraft | undefined {
    const key = this.key(repository, taskId);
    if (!this.values.has(key)) {
      const saved = this.state.get<Partial<TaskNoteDraft> | null>(key);
      const valid = saved && typeof saved.title === 'string' && saved.title.length <= 200 && typeof saved.body === 'string' && saved.body.length <= 10000;
      this.values.set(key, valid ? { title: saved.title!, body: saved.body! } : undefined);
    }
    const value = this.values.get(key);
    return value && { ...value };
  }

  private write(repository: string, taskId: string, value: TaskNoteDraft | undefined) {
    const key = this.key(repository, taskId);
    if (this.deleted.has(key)) return Promise.resolve();
    this.values.set(key, value);
    // A slow save must not overwrite a later edit or a discard after the panel closes.
    const writing = this.pending.catch(() => {}).then(() => this.state.update(key, value));
    this.pending = writing;
    return writing;
  }

  save(repository: string, taskId: string, value: TaskNoteDraft, committed: TaskNoteDraft) {
    return this.write(repository, taskId, same(value, committed) ? undefined : { title: value.title, body: value.body });
  }

  saved(repository: string, taskId: string, submitted: TaskNoteDraft) {
    // The user may have continued typing while the task update was in flight.
    if (!same(this.read(repository, taskId), submitted)) return Promise.resolve();
    return this.write(repository, taskId, undefined);
  }

  flush() {
    return this.pending;
  }
  async forget(repository: string, taskId: string) {
    const writing = this.write(repository, taskId, undefined);
    this.deleted.add(this.key(repository, taskId));
    await writing;
  }
}
