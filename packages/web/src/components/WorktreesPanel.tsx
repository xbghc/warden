import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CreateWorktreeResponse, TargetKey, WorktreeDetail, WorktreesResponse } from '@warden/shared';
import { formatTargetKey, parseTargetKey } from '@warden/shared';
import { api, ApiError } from '../api';
import { copyText } from '../lib/clipboard';
import { useStore } from '../store';
import { WorktreeExtras } from './WorktreeExtras';
import { ActionIcon } from './ActionIcon';

/** The last segment of a path, whichever separator the server's platform uses. */
const dirName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Checking a branch out. A branch that exists is checked out as it is, one only a remote has is
 * checked out tracking the remote, and any other name becomes a branch from the base. Which of these
 * a name is, the server decides when the request arrives — this list may predate a fetch — so the
 * base goes out only when it was typed, never the suggestion shown in its place. Where it goes is a
 * slot: a free one is reused, directory and installed dependencies included, and failing that a new
 * directory is made. The picker lists both, lowest free slot first; a row's 检出到这里 sets it.
 */
function AddForm({
  data,
  slot,
  onSlot,
  focusKey,
  onDone,
}: {
  data: WorktreesResponse;
  /** The slot picked, in the form or from a row; null until then. */
  slot: number | null;
  onSlot: (slot: number) => void;
  /** Bumped by a row's 检出到这里, so the branch field takes focus again. */
  focusKey: number;
  onDone: (res: CreateWorktreeResponse, branch: string) => void;
}) {
  const repo = useStore((s) => s.repo);
  const showToast = useStore((s) => s.showToast);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const branchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey) branchField.current?.focus();
  }, [focusKey]);
  const name = branch.trim();
  const local = useMemo(() => data.branches.some((b) => b.name === name), [data.branches, name]);
  // Remote branches do not come with the list — a remote can carry thousands — so the name typed is
  // looked up on its own once typing pauses, to tell a remote branch from a new name before submitting.
  const [lookup, setLookup] = useState<{ name: string; remotes: string[] } | null>(null);
  useEffect(() => {
    if (!name || local) return;
    let alive = true;
    const timer = setTimeout(() => {
      api
        .remoteBranches(name)
        .then((res) => {
          if (alive) setLookup({ name, remotes: res.remotes });
        })
        // A name git would refuse is on no remote either; submitting it says what is wrong with it.
        .catch(() => {});
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [name, local]);
  const remotes = !local && lookup?.name === name ? lookup.remotes : [];
  // Nothing is left to choose for a local branch, nor for a remote one when only one remote has it.
  const baseFixed = local || remotes.length === 1;
  // Only a branch nobody has checked out can be offered: git keeps one worktree per branch.
  const free = data.branches.filter((b) => !b.worktree);
  const freeSlots = data.worktrees.filter((w) => w.free).sort((a, b) => a.slot! - b.slot!);
  // The lowest free slot, unless one was picked and is still on offer: the list may have moved under it.
  const offered = slot !== null && (slot === data.newSlot.slot || freeSlots.some((w) => w.slot === slot));
  const chosen = offered ? slot! : (freeSlots[0]?.slot ?? data.newSlot.slot);
  const chosenPath = freeSlots.find((w) => w.slot === chosen)?.path ?? data.newSlot.path;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name || busy) return;
    setBusy(true);
    try {
      const typed = base.trim();
      const res = await api.createWorktree({ branch: name, slot: chosen, ...(typed && !baseFixed ? { base: typed } : {}) });
      setBranch('');
      setBase('');
      onDone(res, name);
    } catch (err) {
      showToast(message(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="side-form wt-add" onSubmit={(e) => void submit(e)}>
      <div className="side-group-title">检出分支</div>
      <label className="field">
        分支
        <input
          ref={branchField}
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
      <label
        className="field"
        title={
          local
            ? '现有分支直接检出，不需要 base'
            : remotes.length === 1
              ? `从 ${remotes[0]} 检出，本地分支跟踪它`
              : remotes.length
                ? '多个 remote 都有这个分支，填写要跟踪的那一个'
                : '新分支从这个 ref 创建'
        }
      >
        基于
        <input
          value={baseFixed ? '' : base}
          onChange={(e) => setBase(e.target.value)}
          placeholder={local ? '直接检出现有分支' : remotes.length ? remotes.join(' 或 ') : (repo?.defaultBase ?? 'HEAD')}
          disabled={baseFixed}
          spellCheck={false}
          aria-label="base"
        />
      </label>
      <label className="field" title="空闲工位复用它的目录和装好的依赖；新工位是一个新目录，依赖要重新安装">
        工位
        <select value={chosen} onChange={(e) => onSlot(Number(e.target.value))} aria-label="工位">
          {freeSlots.map((w) => (
            <option key={w.slot} value={w.slot}>
              {dirName(w.path)}（空闲，复用依赖）
            </option>
          ))}
          <option value={data.newSlot.slot}>{dirName(data.newSlot.path)}（新目录，需装依赖）</option>
        </select>
      </label>
      <div className="wt-path muted mono" title={chosenPath}>
        {chosenPath}
      </div>
      <button type="submit" disabled={busy || !name}>
        {busy ? '检出中…' : local ? '检出' : remotes.length ? '检出远程分支' : '新建分支并检出'}
      </button>
    </form>
  );
}

/**
 * One row per checkout: switch the review to it, copy its path for an agent, release its slot or
 * take it down. Releasing or removing one with uncommitted changes is confirmed in the row, since
 * those changes go with it. A free slot is a row of its own — a directory waiting for a branch —
 * and its 检出到这里 points the form at it.
 */
export function WorktreesPanel() {
  const root = useStore((s) => s.root);
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);
  const reloadRepo = useStore((s) => s.reloadRepo);
  const showToast = useStore((s) => s.showToast);
  const sideSlot = useStore((s) => s.sideSlot);
  const showComments = useStore((s) => s.showComments);
  // The counts below move when an agent replies or fetches, which only the state event reports.
  const stateSeq = useStore((s) => s.stateSeq);
  const [data, setData] = useState<WorktreesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [deleteBranch, setDeleteBranch] = useState(true);
  /** Releasing a slot keeps its directory; ticked, the directory goes too, as with any other worktree. */
  const [deleteDir, setDeleteDir] = useState(false);
  /**
   * The release or removal being asked about, in its row. `forced` is null the first time — the
   * plain question, with its options — and set once git has refused without force, which is the
   * only thing that sends one.
   */
  const [confirming, setConfirming] = useState<{ path: string; forced: 'dirty' | 'other' | null; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.worktrees());
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, stateSeq]);

  const target = useMemo(() => parseTargetKey(targetKey), [targetKey]);
  // Another worktree is a different review altogether; the kind of target carries over, as in the
  // top bar's selector. The server's own root is the target without a worktree. A checkpoint does
  // not: it was taken in one worktree, and its number names another one, or none, anywhere else.
  const open = (wt: WorktreeDetail) =>
    setTarget(formatTargetKey({ ...(target.kind === 'checkpoint' ? { kind: 'working' } : target), worktree: wt.isMain ? undefined : wt.path }));

  /** Where a review count leads: the pool its latest comment sits in, with the rail filtered to the kind. */
  const showIn = async (key: TargetKey | undefined, filter: 'replied' | 'unexported') => {
    if (key && key !== targetKey) await setTarget(key);
    showComments(filter);
  };

  const checkedOut = async (res: CreateWorktreeResponse, branch: string) => {
    const name = dirName(res.worktree.path);
    showToast(res.reused ? `已在 ${name} 检出 ${branch}，目录和依赖复用` : `已新建 ${name} 并检出 ${branch}，依赖需要安装`);
    setSlot(null);
    await Promise.all([load(), reloadRepo()]);
  };

  /** Whether the row's action keeps the directory: a slot on a branch, unless the directory was asked for too. */
  const releases = (wt: WorktreeDetail) => wt.slot !== undefined && !wt.free && !wt.prunable && !deleteDir;

  const takeDown = async (wt: WorktreeDetail, force: boolean) => {
    setBusy(wt.path);
    const name = dirName(wt.path);
    try {
      const body = { path: wt.path, force, deleteBranch: deleteBranch && !!wt.branch && !wt.free };
      const res = releases(wt) ? await api.releaseWorktree(body) : await api.removeWorktree(body);
      setConfirming(null);
      const did = releases(wt) ? '已释放' : wt.prunable ? '已清理' : '已删除';
      if (res.branchError) showToast(`${did} ${name}，分支 ${wt.branch} 保留：${res.branchError}`);
      else if (res.branchDeleted) showToast(`${did} ${name} 和分支 ${wt.branch}`);
      else showToast(`${did} ${name}`);
      // The review cannot stay in a worktree that is gone, and a released one has nothing to show.
      if (root === wt.path) await setTarget(formatTargetKey({ kind: 'working' }));
      await Promise.all([load(), reloadRepo()]);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'worktree_dirty' || e.code === 'needs_force')) {
        // The count shown with the question is re-read first: the row may predate the changes.
        await load();
        setConfirming({ path: wt.path, forced: e.code === 'worktree_dirty' ? 'dirty' : 'other', message: e.message });
      } else showToast(message(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const copy = (p: string) =>
    copyText(p).then(
      () => showToast('已复制路径'),
      (e: unknown) => showToast(message(e), 'error'),
    );

  const freeCount = data?.worktrees.filter((w) => w.free).length ?? 0;
  // The form goes in the sidebar and the list keeps the middle, so a row's actions sit beside the
  // row instead of a screen-width away. The options of a release or removal belong with it, not
  // with 检出, so they are asked in the row that is being let go.
  const controls = (
    <>
      {data ? (
        <AddForm data={data} slot={slot} onSlot={setSlot} focusKey={focusKey} onDone={(res, branch) => void checkedOut(res, branch)} />
      ) : (
        <div className="muted empty">加载中…</div>
      )}
      <div className="side-form-status muted small">
        {data ? `${data.worktrees.length} 个 worktree${freeCount ? `，${freeCount} 个空闲工位` : ''}` : ''}
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
          const name = dirName(wt.path);
          const isSlot = wt.slot !== undefined;
          return (
            <div key={wt.path} className={`wt-row ${isCurrent ? 'active' : ''} ${wt.prunable ? 'gone' : ''} ${wt.free ? 'free' : ''}`}>
              <div className="wt-main">
                <div className="wt-head">
                  <span className="wt-name mono" title={wt.path}>
                    {wt.free ? name : (wt.branch ?? `detached ${wt.head.slice(0, 7)}`)}
                  </span>
                  {wt.isMain ? (
                    <span className="badge">主仓库</span>
                  ) : wt.free ? (
                    <span className="badge">空闲</span>
                  ) : (
                    <span className="badge" title={wt.path}>
                      {name}
                    </span>
                  )}
                  {wt.prunable ? (
                    <span className="badge badge-orphaned">目录已不存在</span>
                  ) : wt.foreign ? (
                    <span className="badge badge-orphaned" title="这个目录现在是另一个仓库，warden 不会在里面释放或检出">
                      不属于本仓库
                    </span>
                  ) : wt.busy ? (
                    <span className="badge badge-orphaned" title="先在终端里完成或中止它，再释放或检出">
                      {wt.busy} 进行中
                    </span>
                  ) : wt.dirty > 0 ? (
                    <span className="badge">{wt.dirty} 处未提交改动</span>
                  ) : null}
                  {isCurrent && <span className="badge badge-open">当前</span>}
                  {/* Where this worktree's agent stands with its review: the reason to go there next. */}
                  {!!wt.review?.toReviewer && (
                    <button
                      className="badge badge-active wt-review"
                      onClick={() => void showIn(wt.review!.toReviewerTarget, 'replied')}
                      title="agent 回复了这些评论，等你确认或追问"
                    >
                      {wt.review.toReviewer} 条待确认
                    </button>
                  )}
                  {!!wt.review?.toAgent && (
                    <button
                      className="badge badge-active wt-review"
                      onClick={() => void showIn(wt.review!.toAgentTarget, 'unexported')}
                      title="还没交给 agent 的评论：复制给它，或等它运行 warden feedback"
                    >
                      {wt.review.toAgent} 条未交付
                    </button>
                  )}
                </div>
                {wt.free ? <div className="muted small">目录和装好的依赖都还在，等下一个分支检出到这里。</div> : <WorktreeExtras wt={wt} />}
                {confirming?.path === wt.path && (
                  <div className="wt-confirm">
                    <span>
                      {confirming.forced === 'dirty'
                        ? `${wt.dirty > 0 ? `有 ${wt.dirty} 处未提交的改动` : '有未提交的改动'}，${releases(wt) ? '释放' : '删除'}会把它们一起丢掉。`
                        : confirming.forced === 'other'
                          ? `git 拒绝了：${confirming.message}。要强制删除吗？`
                          : wt.prunable
                            ? `清理 ${name} 的记录；它的目录已经不在了。`
                            : wt.free
                              ? `删除 ${name} 的目录。下次检出到新目录时依赖要重新安装。`
                              : releases(wt)
                                ? `释放 ${name}：目录和装好的依赖留给下一个分支。`
                                : `删除 ${name}，连同它的目录。`}
                    </span>
                    {wt.branch && !wt.isMain && !wt.free && (
                      <label className="check" title="git branch -d：没合并的分支会保留">
                        <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                        一并删除分支 {wt.branch}
                      </label>
                    )}
                    {isSlot && !wt.free && !wt.prunable && confirming.forced !== 'other' && (
                      <label className="check" title="git worktree remove：目录连同依赖一起删掉">
                        <input type="checkbox" checked={deleteDir} onChange={(e) => setDeleteDir(e.target.checked)} />
                        连目录一起删除
                      </label>
                    )}
                    <span className="spacer" />
                    <button className="link danger" disabled={busy === wt.path} onClick={() => void takeDown(wt, confirming.forced !== null)}>
                      {confirming.forced === 'dirty'
                        ? releases(wt)
                          ? '仍然释放'
                          : '仍然删除'
                        : confirming.forced === 'other'
                          ? '强制删除'
                          : releases(wt)
                            ? '释放'
                            : wt.prunable
                              ? '清理'
                              : '删除'}
                    </button>
                    <button className="link" onClick={() => setConfirming(null)}>
                      取消
                    </button>
                  </div>
                )}
              </div>
              <div className="wt-actions">
                {wt.free ? (
                  <button
                    className="link"
                    onClick={() => {
                      setSlot(wt.slot!);
                      setFocusKey((k) => k + 1);
                    }}
                    title="把左边的表单指向这个工位"
                  >
                    <ActionIcon name="branch" label="检出到这里" />
                  </button>
                ) : (
                  <>
                    {!wt.prunable && !isCurrent && (
                      <button className="link" onClick={() => void open(wt)} title="把 review 切换到这个 worktree">
                        <ActionIcon name="forward" label="查看 worktree" />
                      </button>
                    )}
                    <button className="link" onClick={() => void copy(wt.path)} title="复制路径，贴给 agent">
                      <ActionIcon name="copy" label="复制路径" />
                    </button>
                  </>
                )}
                {!wt.isMain && (
                  <button
                    className={`link ${isSlot && !wt.free && !wt.prunable ? '' : 'danger'}`}
                    disabled={busy === wt.path || confirming?.path === wt.path}
                    onClick={() => {
                      setDeleteDir(false);
                      setConfirming({ path: wt.path, forced: null, message: '' });
                    }}
                  >
                    <ActionIcon
                      name={isSlot && !wt.free && !wt.prunable ? 'unlink' : 'delete'}
                      label={wt.prunable ? '清理' : wt.free ? '删除目录' : isSlot ? '释放' : '删除'}
                    />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {data && data.worktrees.length === 1 && <div className="wt-empty muted">只有主仓库。用左边的表单检出一个分支，让 agent 在自己的工位里工作。</div>}
      </div>
    </div>
  );
}
