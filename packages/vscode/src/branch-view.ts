import type { Memento } from 'vscode';
import type { HistoryPreviewRequest, WorkflowResponse } from '@warden/shared';

interface BranchView {
  selected?: string;
  historyDraft?: HistoryPreviewRequest;
}

/** UI choices belong to the requirement even when two branch tips are identical. */
export class BranchViews {
  constructor(private readonly state: Memento) {}

  private key(repository: string, branch: string) {
    return `warden.branch-view:${JSON.stringify([repository, branch])}`;
  }

  async load(repository: string, data: WorkflowResponse): Promise<BranchView> {
    const branch = data.workflow?.developmentBranch;
    if (!branch) return {};
    const key = this.key(repository, branch);
    let saved: BranchView = {
      selected: this.state.get<string>(`${key}:selected`),
      historyDraft: this.state.get<HistoryPreviewRequest>(`${key}:history`),
    };
    const migrated = `warden.branch-views-migrated:${repository}`;
    if (!this.state.get<boolean>(migrated)) {
      // Older versions kept one view for the configured requirement. Adopt it once;
      // a newly visited branch must never inherit that repository-wide draft again.
      saved = {
        selected: saved.selected ?? this.state.get<string>(`warden.selected:${repository}`),
        historyDraft: saved.historyDraft ?? this.state.get<HistoryPreviewRequest>(`warden.history:${repository}`),
      };
      await this.state.update(`${key}:selected`, saved.selected);
      await this.state.update(`${key}:history`, saved.historyDraft);
      await this.state.update(migrated, true);
    }
    const tasks = data.workflow!.changes.filter((task) => task.developmentBranch === branch);
    return {
      selected: tasks.some((task) => task.id === saved.selected) ? saved.selected : tasks[0]?.id,
      historyDraft: saved.historyDraft,
    };
  }

  async select(repository: string, branch: string, selected: string) {
    const key = this.key(repository, branch);
    await this.state.update(`${key}:selected`, selected);
  }

  async draft(repository: string, branch: string, historyDraft: HistoryPreviewRequest | undefined) {
    const key = this.key(repository, branch);
    await this.state.update(`${key}:history`, historyDraft);
  }
}
