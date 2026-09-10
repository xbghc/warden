import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { WorktreeDetail, WorktreesResponse } from '@warden/shared';
import { formatTargetKey, parseTargetKey } from '@warden/shared';
import { api, ApiError } from '../api';
import { copyText } from '../lib/clipboard';
import { useStore } from '../store';

/** `feature/x` as a directory name. */
const slug = (branch: string) => branch.trim().replace(/\//g, '-');
const dirName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/**
 * New worktree: a branch that does not exist yet is made from the base; one that does is checked
 * out as it is. The path follows the branch until it is edited by hand.
 */
function AddForm({ data, onDone }: { data: WorktreesResponse; onDone: (path: string) => void }) {
  const repo = useStore((s) => s.repo);
  const showToast = useStore((s) => s.showToast);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = branch.trim();
  const existing = useMemo(() => data.branches.find((b) => b.name === name), [data.branches, name]);
  const suggestedBase = repo?.defaultBase ?? 'HEAD';
  const shownPath = path ?? (name ? data.pathPrefix + slug(name) : '');
  // Only a branch nobody has checked out can be offered: git keeps one worktree per branch.
  const free = data.branches.filter((b) => !b.worktree);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const target = shownPath.trim();
    if (!name || !target || busy) return;
    setBusy(true);
    try {
      const made = await api.createWorktree({ path: target, branch: name, ...(existing ? {} : { base: base.trim() || suggestedBase }) });
      onDone(made.path);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="side-form wt-add" onSubmit={(e) => void submit(e)}>
      <div className="side-group-title">新建 worktree</div>
      <label className="field">
        分支
        <input
          list="wt-branches"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="新分支名，或一个现有分支"
          spellCheck={false}
          autoFocus
          aria-label="分支"
        />
        <datalist id="wt-branches">
          {free.map((b) => (
            <option key={b.name} value={b.name} />
          ))}
        </datalist>
      </label>
      <label className="field" title={existing ? '现有分支直接检出，不需要 base' : '新分支从这个 ref 创建'}>
        基于
        <input value={base} onChange={(e) => setBase(e.target.value)} placeholder={suggestedBase} disabled={!!existing} spellCheck={false} aria-label="base" />
      </label>
      <label className="field">
        路径
        <input
          className="mono"
          value={shownPath}
          onChange={(e) => setPath(e.target.value)}
          placeholder={`${data.pathPrefix}<branch>`}
          spellCheck={false}
          aria-label="路径"
        />
      </label>
      <button type="submit" disabled={busy || !name || !shownPath.trim()}>
        {busy ? '创建中…' : existing ? '检出到新 worktree' : '新建分支和 worktree'}
      </button>
    </form>
  );
}

/**
 * One row per checkout: switch the review to it, copy its path for an agent, or take it down.
 * Removing one with uncommitted changes is confirmed in the row, since those changes go with it.
 */
export function WorktreesPanel() {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repo);
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);
  const reloadRepo = useStore((s) => s.reloadRepo);
  const showToast = useStore((s) => s.showToast);
  const sideSlot = useStore((s) => s.sideSlot);
  const [data, setData] = useState<WorktreesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  /**
   * The removal being asked about, in the row it would remove. `forced` is null the first time —
   * the plain question, with the branch option — and set once git has refused without `--force`,
   * which is the only thing that sends one.
   */
  const [confirming, setConfirming] = useState<{ path: string; forced: 'dirty' | 'other' | null; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.worktrees());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const target = useMemo(() => parseTargetKey(targetKey), [targetKey]);
  // Another worktree is a different review altogether; the kind of target carries over, as in the
  // top bar's selector. The server's own root is the target without a worktree.
  const open = (wt: WorktreeDetail) => void setTarget(formatTargetKey({ ...target, worktree: wt.path === repo?.root ? undefined : wt.path }));

  const created = async (path: string) => {
    showToast(`已创建 worktree ${dirName(path)}`);
    await Promise.all([load(), reloadRepo()]);
  };

  const remove = async (wt: WorktreeDetail, force: boolean) => {
    setBusy(wt.path);
    try {
      const res = await api.removeWorktree({ path: wt.path, force, deleteBranch: deleteBranch && !!wt.branch });
      setConfirming(null);
      if (res.branchError) showToast(`已删除 ${dirName(wt.path)}，分支 ${wt.branch} 保留：${res.branchError}`);
      else if (res.branchDeleted) showToast(`已删除 ${dirName(wt.path)} 和分支 ${wt.branch}`);
      else showToast(wt.prunable ? `已清理 ${dirName(wt.path)}` : `已删除 ${dirName(wt.path)}`);
      // The review cannot stay in a worktree that is gone.
      if (root === wt.path) await setTarget(formatTargetKey({ kind: 'working' }));
      await Promise.all([load(), reloadRepo()]);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'worktree_dirty' || e.code === 'needs_force')) {
        // The count shown with the question is re-read first: the row may predate the changes.
        await load();
        setConfirming({ path: wt.path, forced: e.code === 'worktree_dirty' ? 'dirty' : 'other', message: e.message });
      } else showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const copy = (p: string) =>
    copyText(p).then(
      () => showToast('已复制路径'),
      (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 'error'),
    );

  // The form goes in the sidebar and the list keeps the middle, so a row's actions sit beside the
  // row instead of a screen-width away. The delete option belongs with删除, not with 新建, so it
  // is asked in the row that is being removed.
  const controls = (
    <>
      {data ? <AddForm data={data} onDone={(p) => void created(p)} /> : <div className="muted empty">加载中…</div>}
      <div className="side-form-status muted small">
        {data ? `${data.worktrees.length} 个 worktree` : ''}
        <button className="link" onClick={() => void load()}>
          刷新
        </button>
      </div>
    </>
  );

  return (
    <div className="worktrees-panel">
      {sideSlot && createPortal(controls, sideSlot)}
      <div className="wt-list">
        {error && <div className="wt-empty muted">{error}</div>}
        {data?.worktrees.map((wt) => {
          const isCurrent = wt.path === root;
          return (
            <div key={wt.path} className={`wt-row ${isCurrent ? 'active' : ''} ${wt.prunable ? 'gone' : ''}`}>
              <div className="wt-main">
                <div className="wt-head">
                  <span className="wt-name">{dirName(wt.path)}</span>
                  {wt.isMain && <span className="badge">主仓库</span>}
                  {wt.branch ? <span className="ref ref-branch">{wt.branch}</span> : <span className="ref">detached {wt.head.slice(0, 7)}</span>}
                  {wt.prunable ? (
                    <span className="badge badge-orphaned">目录已不存在</span>
                  ) : wt.dirty > 0 ? (
                    <span className="badge">{wt.dirty} 处未提交改动</span>
                  ) : (
                    <span className="muted small">干净</span>
                  )}
                  {isCurrent && <span className="badge badge-open">当前</span>}
                </div>
                <div className="wt-path mono muted" title={wt.path}>
                  {wt.path}
                </div>
                {confirming?.path === wt.path && (
                  <div className="wt-confirm">
                    <span>
                      {confirming.forced === 'dirty'
                        ? `${wt.dirty > 0 ? `有 ${wt.dirty} 处未提交的改动` : '有未提交的改动'}，删除会把它们一起丢掉。`
                        : confirming.forced === 'other'
                          ? `git 拒绝了：${confirming.message}。要强制删除吗？`
                          : `删除 ${dirName(wt.path)}，连同它的目录。`}
                    </span>
                    {wt.branch && !wt.isMain && (
                      <label className="check" title="git branch -d：没合并的分支会保留">
                        <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                        一并删除分支 {wt.branch}
                      </label>
                    )}
                    <span className="spacer" />
                    <button className="link danger" disabled={busy === wt.path} onClick={() => void remove(wt, confirming.forced !== null)}>
                      {confirming.forced === 'dirty' ? '仍然删除' : confirming.forced === 'other' ? '强制删除' : '删除'}
                    </button>
                    <button className="link" onClick={() => setConfirming(null)}>
                      取消
                    </button>
                  </div>
                )}
              </div>
              <div className="wt-actions">
                {!wt.prunable && !isCurrent && (
                  <button className="link" onClick={() => open(wt)} title="把 review 切换到这个 worktree">
                    查看
                  </button>
                )}
                <button className="link" onClick={() => void copy(wt.path)} title="复制路径，贴给 agent">
                  复制路径
                </button>
                {!wt.isMain && (
                  <button
                    className="link danger"
                    disabled={busy === wt.path || confirming?.path === wt.path}
                    onClick={() => setConfirming({ path: wt.path, forced: null, message: '' })}
                  >
                    {wt.prunable ? '清理' : '删除'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {data && data.worktrees.length === 1 && (
          <div className="wt-empty muted">只有主仓库。用左边的表单开一个 worktree，让 agent 在自己的分支和目录里工作。</div>
        )}
      </div>
    </div>
  );
}
