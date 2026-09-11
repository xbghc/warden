import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon } from './ActionIcon';
import type { CommitInfo } from '@warden/shared';
import { formatTargetKey, parseTargetKey } from '@warden/shared';
import { api } from '../api';
import { useStore } from '../store';

const PAGE = 200;

export function CommitsPanel() {
  const root = useStore((s) => s.root);
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);
  const showToast = useStore((s) => s.showToast);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const worktree = useMemo(() => parseTargetKey(targetKey).worktree, [targetKey]);
  const currentSha = useMemo(() => {
    const t = parseTargetKey(targetKey);
    return t.kind === 'commit' ? t.sha : null;
  }, [targetKey]);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const res = await api.commits({ root, path: pathFilter || undefined, before, limit: PAGE });
        setCommits((prev) => (before ? [...prev, ...res.commits] : res.commits));
        setHasMore(res.hasMore);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error');
      } finally {
        setLoading(false);
      }
    },
    [root, pathFilter, showToast],
  );

  useEffect(() => {
    setCommits([]);
    void load();
  }, [load]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      const last = commits[commits.length - 1];
      if (last) void load(last.sha);
    }
  };

  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return commits;
    return commits.filter((c) => c.subject.toLowerCase().includes(kw) || c.author.toLowerCase().includes(kw) || c.sha.startsWith(kw));
  }, [commits, keyword]);

  return (
    <div className="commits-panel">
      <div className="commits-tools">
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="按 message / 作者过滤（已加载的）" />
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setPathFilter(pathInput.trim());
          }}
        >
          <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} placeholder="按路径过滤 (git log -- path)" spellCheck={false} />
          <button type="submit"><ActionIcon name="filter" label="应用" /></button>
          {pathFilter && (
            <button
              type="button"
              onClick={() => {
                setPathInput('');
                setPathFilter('');
              }}
            >
              <ActionIcon name="close" label="清除" />
            </button>
          )}
        </form>
        <span className="muted">
          {shown.length}/{commits.length} 条{hasMore ? '，滚动加载更多' : ''}
        </span>
      </div>
      <div className="commits-list" ref={listRef} onScroll={onScroll}>
        {shown.map((c) => (
          <div
            key={c.sha}
            className={`commit-row ${currentSha && (c.sha === currentSha || c.sha.startsWith(currentSha)) ? 'active' : ''}`}
            onClick={() => void setTarget(formatTargetKey({ kind: 'commit', sha: c.sha, ...(worktree ? { worktree } : {}) }))}
            title={c.sha}
          >
            <span className="mono sha">{c.shortSha}</span>
            <span className="subject">{c.subject}</span>
            {c.parents.length > 1 && <span className="badge">merge</span>}
            <span className="muted author">{c.author}</span>
            <span className="muted date">{new Date(c.date).toLocaleString()}</span>
          </div>
        ))}
        {loading && <div className="muted empty">加载中…</div>}
        {!loading && commits.length === 0 && <div className="muted empty">没有 commit</div>}
      </div>
    </div>
  );
}
