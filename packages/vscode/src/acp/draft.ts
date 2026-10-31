import type { AcpDraftChange, AcpDraftEdit, AcpModel } from '@warden/shared';

type DraftSnapshot = Pick<AcpModel, 'draft' | 'draftVersion' | 'draftRevision' | 'draftChanges'>;

/** A panel's text edits acknowledge host operations, so late edits cannot erase an excerpt or resurrect a sent draft. */
export class AcpDraft {
  private version = 0;
  private revision = 0;
  private mutation = 0;
  private changes: AcpDraftChange[] = [];
  private last: AcpDraftEdit;

  constructor(private value: string) {
    this.last = { text: value, version: 0, revision: 0 };
  }

  get text() {
    return this.value;
  }

  snapshot(): DraftSnapshot {
    return { draft: this.value, draftVersion: this.version, draftRevision: this.revision, draftChanges: structuredClone(this.changes) };
  }

  resetPanel() {
    this.revision = 0;
    this.changes = [];
    this.last = { text: this.value, version: this.version, revision: 0 };
  }

  update(edit: AcpDraftEdit) {
    if (!Number.isSafeInteger(edit.version) || edit.version < 0 || edit.version > this.version || !Number.isSafeInteger(edit.revision) || edit.revision < 0)
      throw new Error('Invalid draft version. Reopen the conversation.');
    if (edit.revision < this.revision || edit.version < this.last.version) return;
    if (edit.revision === this.last.revision && edit.version === this.last.version) {
      if (edit.text !== this.last.text) throw new Error('The draft changed. Review the latest contents and retry.');
      return;
    }
    let value = edit.text;
    for (const change of this.changes) {
      if (change.version <= edit.version) continue;
      if (change.type === 'append') value = this.appendText(value, change.text);
      else if (edit.revision <= change.revision) value = '';
    }
    this.checkLength(value);
    if (value !== this.value || edit.revision > this.revision) ++this.mutation;
    this.value = value;
    this.revision = edit.revision;
    this.last = { ...edit };
    this.changes = this.changes.filter((change) => change.version > edit.version);
  }

  begin(edit: AcpDraftEdit) {
    const unseen = this.changes.filter((change) => change.version > edit.version);
    // A newer local edit survives completion, even if its clear acknowledgement is still in flight.
    // Require the full history so an unacknowledged selection can never be silently submitted.
    const onlyCompletedDrafts =
      edit.version < this.version &&
      unseen.length === this.version - edit.version &&
      unseen.every((change) => change.type === 'clear' && edit.revision > change.revision);
    if ((edit.version !== this.version && !onlyCompletedDrafts) || edit.revision < this.revision)
      throw new Error('The draft was updated. Review the latest contents before sending.');
    this.update(edit);
    if (edit.text !== this.value) throw new Error('The draft was updated. Review the latest contents before sending.');
    return { text: this.value, mutation: this.mutation };
  }

  complete(mutation: number) {
    if (mutation !== this.mutation) return false;
    this.value = '';
    this.changes.push({ type: 'clear', version: ++this.version, revision: this.revision });
    ++this.mutation;
    return true;
  }

  append(excerpt: string) {
    const value = this.appendText(this.value, excerpt);
    this.checkLength(value);
    this.value = value;
    this.changes.push({ type: 'append', version: ++this.version, text: excerpt });
    ++this.mutation;
  }

  private appendText(value: string, excerpt: string) {
    return [value, excerpt].filter(Boolean).join('\n\n');
  }

  private checkLength(value: string) {
    if (value.length > 100_000) throw new Error('The message is too long. Select less text.');
  }
}
