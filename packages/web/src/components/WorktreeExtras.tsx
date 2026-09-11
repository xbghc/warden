import { useEffect, useRef, useState } from 'react';
import type { CommitInfo, TmuxSession, Todo, WorktreeDetail } from '@warden/shared';
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

function TmuxWindow({ wt, initialSessions, initialError }: { wt: WorktreeDetail; initialSessions: TmuxSession[] | null; initialError: string }) {
  const [sessions, setSessions] = useState(initialSessions);
  const [selected, setSelected] = useState(initialSessions?.[0]?.id ?? '');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const showToast = useStore((s) => s.showToast);
  useEffect(() => {
    if (refresh === 0) return;
    let alive = true;
    setSessions(null);
    setError('');
    setSelected('');
    api
      .tmuxSessions()
      .then((result) => {
        if (!alive) return;
        setSessions(result.sessions);
        setSelected(result.sessions[0]?.id ?? '');
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [refresh]);
  return (
    <div className="wt-tmux">
      <div className="muted small">在主仓库的 tmux session 中新建窗口，目录为 {wt.path}</div>
      {error && <div role="alert">{error}</div>}
      {!sessions && !error && <div role="status">查找 tmux session…</div>}
      {sessions?.length === 0 && <div className="muted">没有工作目录为主仓库的 tmux session。请先在主仓库目录启动 tmux。</div>}
      {!!sessions?.length && (
        <div className="row-actions">
          <select aria-label="tmux session" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !selected}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await api.openTmuxWindow({ path: wt.path, sessionId: selected });
                showToast(`已在 ${result.session} 创建窗口 ${result.window}`);
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <ActionIcon name={busy ? 'loading' : 'add'} label="新建 tmux 窗口" />
          </button>
        </div>
      )}
      <button className="link" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
        <ActionIcon name="refresh" label="刷新 tmux session" />
      </button>
    </div>
  );
}

export function WorktreeExtras({ wt }: { wt: WorktreeDetail }) {
  const [tab, setTab] = useState<'commits' | 'todos' | 'tmux' | null>(null);
  const [tmuxBusy, setTmuxBusy] = useState(false);
  const tmuxPending = useRef(false);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[] | null>(null);
  const [tmuxError, setTmuxError] = useState('');
  const showToast = useStore((s) => s.showToast);
  const openTmux = async () => {
    if (tmuxPending.current) return;
    if (tab === 'tmux') {
      setTab(null);
      return;
    }
    tmuxPending.current = true;
    setTmuxBusy(true);
    setTmuxError('');
    setTmuxSessions(null);
    try {
      const { sessions } = await api.tmuxSessions();
      if (sessions.length === 1) {
        const result = await api.openTmuxWindow({ path: wt.path, sessionId: sessions[0]!.id });
        showToast(`已在 ${result.session} 创建窗口 ${result.window}`);
      } else {
        setTmuxSessions(sessions);
        setTab('tmux');
      }
    } catch (e) {
      setTmuxError(message(e));
      setTab('tmux');
    } finally {
      tmuxPending.current = false;
      setTmuxBusy(false);
    }
  };
  return (
    <div className="wt-extras">
      {wt.comparison && (
        <div className="wt-comparison">
          <span className="wt-commit-count" title={`领先 ${wt.comparison.ahead} 个提交`}>
            <ActionIcon name="up" label="领先提交数" />
            {wt.comparison.ahead}
          </span>
          <span className="wt-commit-count" title={`落后 ${wt.comparison.behind} 个提交`}>
            <ActionIcon name="down" label="落后提交数" />
            {wt.comparison.behind}
          </span>
          <span title="按提交可达性判断；squash/cherry-pick 不算历史合并">{wt.comparison.merged ? '已合并' : '未合并'}</span>
        </div>
      )}
      {wt.comparisonError && <span className="muted">{wt.comparisonError}</span>}
      <div className="row-actions">
        {(['commits', 'todos', 'tmux'] as const).map((item) => (
          <button
            key={item}
            className="link"
            aria-expanded={tab === item}
            disabled={tmuxBusy || (item !== 'todos' && (wt.prunable || wt.bare)) || (item === 'todos' && !wt.branch)}
            onClick={() => (item === 'tmux' ? void openTmux() : setTab(tab === item ? null : item))}
          >
            <ActionIcon
              name={item === 'commits' ? 'history' : item === 'todos' ? 'todos' : tmuxBusy ? 'loading' : 'terminal'}
              label={item === 'commits' ? '提交列表' : item === 'todos' ? '分支 TODO' : 'tmux'}
            />
          </button>
        ))}
      </div>
      {tab && (
        <div className="wt-expanded">
          {tab === 'commits' ? (
            <History key={wt.head} wt={wt} />
          ) : tab === 'todos' ? (
            <BranchTodos key={wt.branch} branch={wt.branch!} />
          ) : (
            <TmuxWindow wt={wt} initialSessions={tmuxSessions} initialError={tmuxError} />
          )}
        </div>
      )}
    </div>
  );
}
