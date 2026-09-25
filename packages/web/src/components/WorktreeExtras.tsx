import { useEffect, useState } from 'react';
import type { CommitInfo, Todo, WorktreeComparison, WorktreeDetail } from '@warden/shared';
import { formatTargetKey } from '@warden/shared';
import { api } from '../api';
import { useStore } from '../store';
import { ActionIcon } from './ActionIcon';
import { Markdown } from './Markdown';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function History({ wt }: { wt: WorktreeDetail }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const setTarget = useStore((s) => s.setTarget);
  const setPanel = useStore((s) => s.setPanel);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api
      .commits({ root: wt.path, ref: wt.head, offset: page * 30, limit: 30 })
      .then((result) => {
        if (!alive) return;
        setCommits((previous) => (page === 0 ? result.commits : [...previous, ...result.commits]));
        setMore(result.hasMore);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [wt.path, wt.head, page]);
  return (
    <div className="wt-history">
      <div className="muted small">分支提交历史（含共享提交）</div>
      {commits.map((commit) => (
        <button
          key={commit.sha}
          className="wt-commit"
          onClick={async () => {
            await setTarget(formatTargetKey({ kind: 'commit', sha: commit.sha, worktree: wt.path }));
            setPanel('diff');
          }}
          title={`查看提交 ${commit.sha}`}
        >
          <code>{commit.shortSha}</code>
          <span>{commit.subject}</span>
          <small>
            {commit.author} · {commit.date.slice(0, 10)}
          </small>
        </button>
      ))}
      {error && <div role="alert">{error}</div>}
      {loading ? (
        <div role="status">加载中…</div>
      ) : more ? (
        <button className="link" onClick={() => setPage((p) => p + 1)}>
          加载更多
        </button>
      ) : !commits.length && !error ? (
        <div className="muted">暂无提交</div>
      ) : null}
    </div>
  );
}

function BranchTodos({ branch }: { branch: string }) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api
      .todos(branch)
      .then((result) => {
        if (alive) setTodos(result.todos);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [branch]);
  return (
    <div>
      <div className="muted small">{branch} 的 TODO</div>
      {error && <div role="alert">{error}</div>}
      {!todos && !error && <div role="status">加载中…</div>}
      {todos?.length === 0 && <div className="muted">此分支暂无 TODO</div>}
      {todos?.map((todo) => (
        <details key={todo.id} className={`wt-todo ${todo.status}`}>
          <summary>
            <ActionIcon name={todo.status === 'done' ? 'done' : 'open'} label={todo.status === 'done' ? '已完成' : '未完成'} />
            <span>{todo.title}</span>
          </summary>
          {todo.body ? <Markdown text={todo.body} /> : <p className="muted">无描述</p>}
        </details>
      ))}
    </div>
  );
}

/**
 * Ahead and behind, with what they are counted against named beside them, since the two read
 * differently: against the branch's upstream they are what is not pushed and not pulled yet; against
 * what the main worktree has checked out, nothing ahead means merged.
 */
function Comparison({ comparison: c }: { comparison: WorktreeComparison }) {
  const upstream = c.kind === 'upstream';
  return (
    <div className="wt-comparison">
      <span className="ref" title={upstream ? `与上游 ${c.base} 比较` : `与主仓库当前检出的 ${c.base} 比较`}>
        {c.base}
      </span>
      <span className="wt-commit-count" title={upstream ? `${c.ahead} 个提交未推送到 ${c.base}` : `领先 ${c.base} ${c.ahead} 个提交`}>
        <ActionIcon name="up" label={upstream ? '未推送提交数' : '领先提交数'} />
        {c.ahead}
      </span>
      <span className="wt-commit-count" title={upstream ? `${c.base} 有 ${c.behind} 个提交未拉取` : `落后 ${c.base} ${c.behind} 个提交`}>
        <ActionIcon name="down" label={upstream ? '未拉取提交数' : '落后提交数'} />
        {c.behind}
      </span>
      {!upstream && <span title="按提交可达性判断；squash/cherry-pick 不算历史合并">{c.ahead === 0 ? '已合并' : '未合并'}</span>}
    </div>
  );
}

export function WorktreeExtras({ wt }: { wt: WorktreeDetail }) {
  const [tab, setTab] = useState<'commits' | 'todos' | null>(null);
  const [tmuxBusy, setTmuxBusy] = useState(false);
  const showToast = useStore((s) => s.showToast);
  // A session of its own for the worktree, made in the background; getting into it is up to you.
  const openTmux = async () => {
    if (tmuxBusy) return;
    setTmuxBusy(true);
    try {
      const res = await api.openTmuxSession({ path: wt.path });
      showToast(res.created ? `已创建 tmux session ${res.session}` : `tmux session ${res.session} 已存在`);
    } catch (e) {
      showToast(message(e), 'error');
    } finally {
      setTmuxBusy(false);
    }
  };
  return (
    <div className="wt-extras">
      {wt.comparison && <Comparison comparison={wt.comparison} />}
      {wt.upstreamGone && (
        <span className="muted" title="通常是远端分支合并后被删除了">
          上游 {wt.upstreamGone} 已不存在
        </span>
      )}
      {wt.comparisonError && <span className="muted">{wt.comparisonError}</span>}
      <div className="row-actions">
        {(['commits', 'todos'] as const).map((item) => (
          <button
            key={item}
            className="link"
            aria-expanded={tab === item}
            disabled={(item === 'commits' && (wt.prunable || wt.bare)) || (item === 'todos' && !wt.branch)}
            onClick={() => setTab(tab === item ? null : item)}
          >
            <ActionIcon name={item === 'commits' ? 'history' : 'todos'} label={item === 'commits' ? '提交列表' : '分支 TODO'} />
          </button>
        ))}
        <button
          className="link"
          disabled={tmuxBusy || wt.prunable || wt.bare}
          onClick={() => void openTmux()}
          title={`在 ${wt.path} 新建 tmux session（已有就复用），不切换过去`}
        >
          <ActionIcon name={tmuxBusy ? 'loading' : 'terminal'} label="tmux session" />
        </button>
      </div>
      {tab && <div className="wt-expanded">{tab === 'commits' ? <History key={wt.head} wt={wt} /> : <BranchTodos key={wt.branch} branch={wt.branch!} />}</div>}
    </div>
  );
}
