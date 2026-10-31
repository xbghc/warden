import { randomUUID } from 'node:crypto';
import type { HistoryPreviewRequest, HistoryPreviewResponse, HistoryResponse } from '@warden/shared';
import { badRequest, WardenError } from './errors.js';
import { runGit, runGitWrite } from './git.js';
import { GitSandbox, gitMessage, gitOid, oid } from './git-sandbox.js';
import { PreviewService, primaryCheckout } from './preview.js';
import type { RepoContext } from './repo.js';
import type { StateStore } from './state.js';
import { dirtyCount } from './worktrees.js';
import { assertSafetyBackupCurrent, createSafetyBackup, discardOperationBackup } from './backups.js';
import { retireWorkflowRefs } from './retention.js';

function fail(message: string, code = 'history_changed'): never {
  throw new WardenError(409, message, code);
}

export class HistoryService {
  constructor(
    private repo: RepoContext,
    private store: StateStore,
  ) {}

  async get(): Promise<HistoryResponse> {
    const state = await this.store.load();
    const branch = state.workflow?.developmentBranch;
    if (!branch) throw badRequest('Select a base branch first.');
    const head = await oid(this.repo.commonRoot, `refs/heads/${branch}`);
    const log = await runGit(['log', '-100', '--format=%H%x00%P%x00%B%x00%an%x00%aI%x00', head, '--'], { cwd: this.repo.commonRoot });
    const fields = log.stdout.split('\0');
    const commits: HistoryResponse['commits'] = [];
    for (let i = 0; i + 4 < fields.length; i += 5) {
      const sha = fields[i]!.trim();
      if (!gitOid(sha)) continue;
      const owner = state.workflow!.changes.find((c) => c.worktree && c.deliveries?.some((d) => d.commit === sha));
      const delivery = owner?.worktree ? owner.deliveries?.find((d) => d.commit === sha) : undefined;
      commits.push({
        sha,
        parents: fields[i + 1]!.split(' ').filter(Boolean),
        message: fields[i + 2]!.trimEnd(),
        author: fields[i + 3]!,
        date: fields[i + 4]!,
        changeId: owner?.id,
        deliveryId: delivery?.id,
      });
    }
    return { branch, head, commits: commits.reverse() };
  }

  preview(request: HistoryPreviewRequest): Promise<HistoryPreviewResponse> {
    if (
      !gitOid(request?.head) ||
      !gitOid(request?.start) ||
      !Array.isArray(request?.commits) ||
      !request.commits.length ||
      request.commits.length > 100 ||
      request.commits.some((c) => !gitOid(c?.sha) || typeof c.message !== 'string' || !c.message.trim() || c.message.length > 10000)
    )
      throw badRequest('Invalid commit arrangement.');
    return this.store.withRepositoryLock(async () => {
      await this.recover();
      const history = await this.get();
      if (history.head !== request.head) fail('The base branch has new commits. Refresh the history.');
      const first = history.commits.findIndex((c) => c.sha === request.start);
      if (first < 0) throw badRequest('Select a starting point within the most recent 100 commits.');
      const range = history.commits.slice(first);
      if (range.some((c) => c.parents.length !== 1) || range.some((c, i) => i > 0 && c.parents[0] !== range[i - 1]!.sha))
        throw badRequest('Only consecutive linear commits are supported; root and merge commits are not supported.', 'history_not_linear');
      const selected = new Set(request.commits.map((c) => c.sha));
      if (request.commits.length !== range.length || selected.size !== range.length || range.some((c) => !selected.has(c.sha)))
        throw badRequest('The draft must include every commit from the starting point to HEAD exactly once.');
      const previous = (await this.store.load()).historyDraft;
      await this.store.update((s) => {
        delete s.historyDraft;
      });
      if (previous?.sandbox) await GitSandbox.open(this.store, previous.sandbox).dispose();
      const sandbox = await GitSandbox.create(this.store, this.repo.commonRoot, range[0]!.parents[0]!);
      let retained = false;
      const result: HistoryPreviewResponse = { head: history.head, canApply: false, contentChanged: false, conflicts: [], commits: [] };
      try {
        await sandbox.fetch(this.repo.commonRoot, history.head);
        for (const entry of request.commits) {
          try {
            await sandbox.write(['cherry-pick', '--allow-empty', '--keep-redundant-commits', entry.sha]);
            if (entry.message.trim() !== range.find((c) => c.sha === entry.sha)!.message.trim())
              await sandbox.write(['commit', '--amend', '--allow-empty', '--quiet', '-m', entry.message.trim()]);
            result.commits.push({ source: entry.sha, sha: await oid(sandbox.path, 'HEAD'), message: entry.message.trim() });
          } catch (error) {
            result.conflicts = await sandbox.conflicts();
            result.message = `Unable to apply this arrangement. Adjust the order and preview again: ${gitMessage(error)}`;
            return result;
          }
        }
        result.newHead = await oid(sandbox.path, 'HEAD');
        result.contentChanged = (await oid(sandbox.path, 'HEAD^{tree}')) !== (await oid(sandbox.path, `${history.head}^{tree}`));
        if (result.contentChanged) {
          result.message = 'This arrangement changes the final file contents. Adjust the order; history edits must preserve the final contents.';
          return result;
        }
        if ((await oid(this.repo.commonRoot, `refs/heads/${history.branch}`)) !== history.head) {
          result.message = 'The base branch changed during preview. Refresh and retry.';
          return result;
        }
        result.id = randomUUID();
        result.canApply = true;
        await this.store.update((s) => {
          s.historyDraft = { ...result, branch: history.branch, sandbox: sandbox.path };
        });
        retained = true;
        return result;
      } finally {
        if (!retained) await sandbox.dispose();
      }
    });
  }

  apply(request: { id: string; head: string }) {
    if (typeof request?.id !== 'string' || !gitOid(request?.head)) throw badRequest('Invalid commit arrangement request.');
    return this.store.withRepositoryLock(async () => {
      if (await this.recover()) return this.get();
      const state = await this.store.load();
      const draft = state.historyDraft;
      if (!draft?.canApply || !draft.newHead || draft.id !== request.id || draft.head !== request.head)
        fail('The draft preview is out of date. Preview it again.');
      if (state.workflow?.developmentBranch !== draft.branch || state.workflow.changes.some((c) => c.status === 'integrating'))
        fail('Finish the commit in the primary folder before editing history.', 'development_in_use');
      if ((await oid(this.repo.commonRoot, `refs/heads/${draft.branch}`)) !== draft.head) fail('The base branch has new commits. Recreate the arrangement.');
      const preview = new PreviewService(this.repo, this.store);
      await preview.suspend();
      try {
        const primary = await primaryCheckout(this.repo, draft.branch);
        if (await dirtyCount(primary.path)) fail('The primary folder has other changes. Handle them before retrying.', 'development_dirty');
        const sandbox = GitSandbox.open(this.store, draft.sandbox);
        if ((await oid(sandbox.path, `${draft.newHead}^{tree}`)) !== (await oid(primary.path, 'HEAD^{tree}')))
          fail('The preview does not match the current contents. Recreate the arrangement.');
        const backup = await createSafetyBackup(this.store, primary.path, 'history');
        if ((await oid(primary.path, 'HEAD')) !== draft.head || (await dirtyCount(primary.path)))
          fail('The primary folder changed during backup. Recreate the arrangement.');
        await assertSafetyBackupCurrent(backup);
        await this.store.update((s) => {
          s.historyDraft!.backups = [...(s.historyDraft!.backups ?? []), backup];
        });
        await runGitWrite(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', sandbox.path, draft.newHead], { cwd: primary.path });
        await this.store.update((s) => {
          s.historyDraft!.applying = true;
        });
        // The final tree is identical: changing the ref leaves the real index and all files intact.
        await runGitWrite(['update-ref', `refs/heads/${draft.branch}`, draft.newHead, draft.head], { cwd: primary.path });
        await this.recover();
      } finally {
        await preview.resume();
      }
      return this.get();
    });
  }

  /** Complete only an already-published mapping after an interrupted response/process. */
  private async recover() {
    const draft = (await this.store.load()).historyDraft;
    if (!draft?.applying || !draft.newHead) return false;
    const actual = await oid(this.repo.commonRoot, `refs/heads/${draft.branch}`);
    if (actual === draft.head && actual !== draft.newHead) return false;
    if (actual !== draft.newHead) fail('History changed after an interrupted update. Inspect the current commit history.');
    const mapping = new Map(draft.commits.map((c) => [c.source, c]));
    const ancestry = await runGit(['rev-list', '--parents', `--max-count=${draft.commits.length}`, draft.newHead], { cwd: this.repo.commonRoot });
    const parents = new Map(
      ancestry.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [commit, parent] = line.split(' ');
          return [commit!, parent!];
        }),
    );
    await this.store.update((s) => {
      for (const c of s.workflow?.changes ?? []) {
        if (!c.worktree) continue;
        for (const d of c.deliveries ?? []) {
          const rewritten = mapping.get(d.commit);
          if (rewritten) {
            d.commit = rewritten.sha;
            d.message = rewritten.message;
            d.parent = parents.get(rewritten.sha)!;
          }
        }
        if (c.developmentBranch === draft.branch && c.status !== 'accepted')
          c.sync = { status: 'pending', target: draft.newHead!, message: 'Commit history has changed. Rebase workspaces when ready.' };
      }
    });
    await retireWorkflowRefs(this.repo.commonRoot);
    await GitSandbox.open(this.store, draft.sandbox).dispose();
    for (const backup of draft.backups ?? []) await discardOperationBackup(this.store, backup);
    await this.store.update((s) => {
      delete s.historyDraft;
    });
    return true;
  }
}
