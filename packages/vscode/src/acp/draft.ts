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
      throw new Error('草稿版本无效，请重新打开对话');
    if (edit.revision < this.revision || edit.version < this.last.version) return;
    if (edit.revision === this.last.revision && edit.version === this.last.version) {
      if (edit.text !== this.last.text) throw new Error('草稿已变化，请确认最新内容后重试');
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
    if (edit.version !== this.version || edit.revision < this.revision) throw new Error('草稿已更新，请确认最新内容后重新发送');
    this.update(edit);
    if (edit.text !== this.value) throw new Error('草稿已更新，请确认最新内容后重新发送');
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
    if (value.length > 100_000) throw new Error('消息过长，请缩小选区');
  }
}
