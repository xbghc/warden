import { randomUUID } from 'node:crypto';
import type { HistoryPreviewRequest, HistoryPreviewResponse, HistoryResponse } from '@warden/shared';
import { formatTargetKey, tryParseTargetKey } from '@warden/shared';
import { badRequest, HttpError } from './errors.js';
import { runGit, runGitWrite } from './git.js';
import { GitSandbox, gitMessage, gitOid, oid } from './git-sandbox.js';
import { PreviewService, primaryCheckout } from './preview.js';
import type { RepoContext } from './repo.js';
import { ensureTarget, type StateStore } from './state.js';
import { dirtyCount } from './worktrees.js';
import { assertSafetyBackupCurrent, createSafetyBackup } from './backups.js';

function fail(message: string, code = 'history_changed'): never {
  throw new HttpError(409, message, code);
}

export class HistoryService {
  constructor(
    private repo: RepoContext,
    private store: StateStore,
  ) {}

  async get(): Promise<HistoryResponse> {
    const state = await this.store.load();
    const branch = state.workflow?.developmentBranch;
    if (!branch) throw badRequest('请先选择主开发分支');
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
      throw badRequest('提交编排格式错误');
    return this.store.withRepositoryLock(async () => {
      await this.recover();
      const history = await this.get();
      if (history.head !== request.head) fail('主开发分支已有新提交，请刷新历史');
      const first = history.commits.findIndex((c) => c.sha === request.start);
      if (first < 0) throw badRequest('请选择最近 100 个提交中的起点');
      const range = history.commits.slice(first);
      if (range.some((c) => c.parents.length !== 1) || range.some((c, i) => i > 0 && c.parents[0] !== range[i - 1]!.sha))
        throw badRequest('当前仅支持连续线性提交，不支持根提交或 merge 提交', 'history_not_linear');
      const selected = new Set(request.commits.map((c) => c.sha));
      if (request.commits.length !== range.length || selected.size !== range.length || range.some((c) => !selected.has(c.sha)))
        throw badRequest('草稿必须完整包含起点到最新提交，每项恰好一次');
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
            result.message = `编排无法应用，请调整顺序后重新预览：${gitMessage(error)}`;
            return result;
          }
        }
        result.newHead = await oid(sandbox.path, 'HEAD');
        result.contentChanged = (await oid(sandbox.path, 'HEAD^{tree}')) !== (await oid(sandbox.path, `${history.head}^{tree}`));
        if (result.contentChanged) {
          result.message = '编排改变了最终文件内容，请调整顺序；当前只支持保持最终内容的历史整理。';
          return result;
        }
        if ((await oid(this.repo.commonRoot, `refs/heads/${history.branch}`)) !== history.head) {
          result.message = '预览期间主开发分支已变化，请刷新重试';
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
    if (typeof request?.id !== 'string' || !gitOid(request?.head)) throw badRequest('提交编排请求格式错误');
    return this.store.withRepositoryLock(async () => {
      if (await this.recover()) return this.get();
      const state = await this.store.load();
      const draft = state.historyDraft;
      if (!draft?.canApply || !draft.newHead || draft.id !== request.id || draft.head !== request.head) fail('草稿预览已失效，请重新预览');
      if (state.workflow?.developmentBranch !== draft.branch || state.workflow.changes.some((c) => c.status === 'integrating'))
        fail('请先完成主目录提交，再整理历史', 'development_in_use');
      if ((await oid(this.repo.commonRoot, `refs/heads/${draft.branch}`)) !== draft.head) fail('主开发分支已有新提交，请重新编排');
      const preview = new PreviewService(this.repo, this.store);
      await preview.suspend();
      try {
        const primary = await primaryCheckout(this.repo, draft.branch);
        if (await dirtyCount(primary.path)) fail('主目录有其他改动，请自行处理后重试', 'development_dirty');
        const sandbox = GitSandbox.open(this.store, draft.sandbox);
        if ((await oid(sandbox.path, `${draft.newHead}^{tree}`)) !== (await oid(primary.path, 'HEAD^{tree}'))) fail('预览结果与当前内容不一致，请重新编排');
        const backup = await createSafetyBackup(this.store, primary.path, 'history');
        if ((await oid(primary.path, 'HEAD')) !== draft.head || (await dirtyCount(primary.path))) fail('备份期间主目录已变化，请重新编排');
        await assertSafetyBackupCurrent(backup);
        await runGitWrite(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', sandbox.path, draft.newHead], { cwd: primary.path });
        await runGitWrite(['update-ref', `refs/warden/history/${draft.id}`, draft.head], { cwd: primary.path });
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
    if (actual !== draft.newHead) fail('历史发布被中断后又发生变化，请检查当前提交历史');
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
          c.sync = { status: 'pending', target: draft.newHead!, message: '提交历史已更新，可主动同步工作区' };
      }
      for (const [key, target] of Object.entries(s.targets)) {
        const parsed = tryParseTargetKey(key);
        if (parsed?.kind !== 'commit' || parsed.worktree) continue;
        const rewritten = mapping.get(parsed.sha);
        if (!rewritten || rewritten.sha === parsed.sha) continue;
        const next = formatTargetKey({ kind: 'commit', sha: rewritten.sha });
        const destination = ensureTarget(s, next);
        const ids = new Set(destination.comments.map((c) => c.id));
        destination.comments.push(...target.comments.filter((c) => !ids.has(c.id)).map((c) => ({ ...c, targetKey: next })));
        target.comments = [];
      }
      delete s.historyDraft;
    });
    await GitSandbox.open(this.store, draft.sandbox).dispose();
    return true;
  }
}
