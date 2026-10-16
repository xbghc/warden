import { useState } from 'react';
import { ArrowDown, ArrowUp, GitCommitHorizontal, GripVertical, RefreshCw, Trash2 } from 'lucide-react';
import type { HistoryEntry, HistoryPreviewRequest, HistoryPreviewResponse } from '@warden/shared';
import { api } from '../api';
import { useWorkflow } from '../workflow-store';
import { useWorkbenchData, errorMessage } from '../workbench-data';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';
import { OperationError } from './TaskWorkspace';

export function HistoryPage({ active }: { active: boolean }) {
  const { history, errors, checking } = useWorkbenchData();
  const workflow = useWorkflow((state) => state.data?.workflow);
  const tasks = workflow?.changes ?? [];
  const [start, setStart] = useState('');
  const [draftBranch, setDraftBranch] = useState('');
  const [original, setOriginal] = useState<HistoryEntry[]>([]);
  const [draft, setDraft] = useState<HistoryPreviewRequest | null>(null);
  const [preview, setPreview] = useState<HistoryPreviewResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const differentBranch = !!draft && draftBranch !== workflow?.developmentBranch;
  const stale = !!draft && (draft.head !== history?.head || differentBranch);
  const updateDraft = (next: HistoryPreviewRequest) => {
    setDraft(next);
    setPreview(null);
    setError(null);
    setNotice(null);
  };
  const create = () => {
    if (!history) return;
    const index = history.commits.findIndex((commit) => commit.sha === start);
    if (index < 0) return;
    setDraftBranch(history.branch);
    setOriginal(history.commits.slice(index));
    updateDraft({ head: history.head, start, commits: history.commits.slice(index).map(({ sha, message }) => ({ sha, message })) });
  };
  const rebuild = () => {
    if (!draft || !history || differentBranch) return;
    const index = history.commits.findIndex((commit) => commit.sha === draft.start);
    if (index < 0) {
      setError('起点已失效，请丢弃草稿并重选范围。');
      return;
    }
    const current = history.commits.slice(index);
    setOriginal(current);
    const ids = new Set(current.map((commit) => commit.sha));
    const kept = draft.commits.filter((commit) => ids.has(commit.sha));
    updateDraft({
      head: history.head,
      start: draft.start,
      commits: [...kept, ...current.filter((commit) => !kept.some((row) => row.sha === commit.sha)).map(({ sha, message }) => ({ sha, message }))],
    });
  };
  const move = (from: number, to: number) => {
    if (!draft || to < 0 || to >= draft.commits.length || from < 0) return;
    const commits = [...draft.commits];
    const [commit] = commits.splice(from, 1);
    commits.splice(to, 0, commit!);
    updateDraft({ ...draft, commits });
  };
  const inspect = async () => {
    if (!draft) return;
    setPending(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.previewHistory(draft));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const apply = async () => {
    if (!draft || !preview?.id || !preview.canApply || stale) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.applyHistory(preview.id, draft.head);
      useWorkbenchData.setState({ history: result });
      setDraft(null);
      setPreview(null);
      setStart('');
      setNotice('提交历史已更新');
      await Promise.all([useWorkbenchData.getState().refresh(), useWorkflow.getState().refresh()]);
    } catch (error) {
      setError(errorMessage(error));
      await useWorkbenchData.getState().refresh();
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="wb-page wb-history-page" hidden={!active} aria-label="提交历史">
      <header className="wb-page-header">
        <div>
          <span className="wb-eyebrow">{history?.branch ?? '主开发分支'}</span>
          <h1>{draft ? '历史草稿' : '提交历史'}</h1>
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={checking || pending}
          onClick={() => void useWorkbenchData.getState().refresh()}
          aria-label="刷新历史"
          title="刷新历史"
        >
          <RefreshCw size={14} className={checking ? 'animate-spin' : undefined} aria-hidden="true" />
        </Button>
      </header>
      <div className="wb-page-content">
        <OperationError message={error ?? errors.history} />
        {notice && (
          <div className="wb-note" role="status">
            {notice}
          </div>
        )}
        {!draft ? (
          <>
            <div className="wb-section-heading">{history && <span>{history.commits.length} 个提交 · 从早到晚</span>}</div>
            <ol className="wb-history-list">
              {history?.commits.map((commit, index) => (
                <li key={commit.sha}>
                  <span className="wb-commit-node">
                    <GitCommitHorizontal size={18} />
                  </span>
                  <div className="wb-commit-text">
                    <strong>{commit.message.split('\n')[0]}</strong>
                    <small>
                      {commit.changeId ? (tasks.find((task) => task.id === commit.changeId)?.title ?? commit.changeId) : commit.author}
                      {commit.deliveryId && ' · 交付'} · {new Date(commit.date).toLocaleDateString('zh-CN')}
                    </small>
                  </div>
                  <code>{commit.sha.slice(0, 8)}</code>
                  <span className="wb-history-index">{index + 1}</span>
                </li>
              ))}
            </ol>
            {!history?.commits.length && <div className="wb-empty-inline">{errors.history ? '暂无法读取历史' : !history ? '加载中…' : '暂无提交'}</div>}
            <div className="wb-history-range">
              <label className="wb-field">
                起点
                <NativeSelect aria-label="历史编排起点" value={start} onChange={(event) => setStart(event.target.value)}>
                  <option value="">选择起点提交</option>
                  {history?.commits.map((commit) => (
                    <option key={commit.sha} value={commit.sha}>
                      {commit.sha.slice(0, 8)} · {commit.message.split('\n')[0]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <p className="muted small">从此提交到分支末端，仅支持线性历史。</p>
              <Button disabled={!start || !history || !!errors.history} onClick={create}>
                调整历史
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="wb-draft-meta">
              <span>
                基于 <code>{draft.head.slice(0, 8)}</code>
              </span>
              <span>{draft.commits.length} 个提交</span>
            </div>
            {stale && (
              <div className="wb-error">
                <strong>{differentBranch ? `此草稿属于 ${draftBranch}` : '主开发分支已更新'}</strong>
                <p>{differentBranch ? '请切回该分支，或丢弃草稿。' : '草稿已过期，请更新后重新预览。'}</p>
                <Button size="icon-sm" variant="outline" onClick={rebuild} disabled={pending || differentBranch} aria-label="更新草稿" title="更新草稿">
                  <RefreshCw size={14} aria-hidden="true" />
                </Button>
              </div>
            )}
            <div className="wb-history-draft">
              <div className="wb-history-original">
                <h2>原顺序</h2>
                {original.map((commit, index) => (
                  <div key={commit!.sha}>
                    <span>{index + 1}</span>
                    <p>
                      {commit!.message.split('\n')[0]}
                      <code>{commit!.sha.slice(0, 8)}</code>
                    </p>
                  </div>
                ))}
              </div>
              <div className="wb-history-arranged">
                <h2>草稿顺序</h2>
                {draft.commits.map((commit, index) => (
                  <div
                    key={commit.sha}
                    className="wb-draft-commit"
                    draggable={!pending}
                    onDragStart={() => setDragging(commit.sha)}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragging)
                        move(
                          draft.commits.findIndex((row) => row.sha === dragging),
                          index,
                        );
                      setDragging(null);
                    }}
                  >
                    <GripVertical size={15} className="muted" />
                    <span>{index + 1}</span>
                    <div>
                      <Textarea
                        rows={2}
                        aria-label={`提交说明 ${index + 1}`}
                        value={commit.message}
                        disabled={pending}
                        onChange={(event) =>
                          updateDraft({
                            ...draft,
                            commits: draft.commits.map((row) => (row.sha === commit.sha ? { ...row, message: event.target.value } : row)),
                          })
                        }
                      />
                      <code>{commit.sha.slice(0, 8)}</code>
                    </div>
                    <div className="wb-draft-order">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`上移提交 ${index + 1}`}
                        title="上移提交"
                        disabled={pending || index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        <ArrowUp size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`下移提交 ${index + 1}`}
                        title="下移提交"
                        disabled={pending || index === draft.commits.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        <ArrowDown size={13} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {preview && (
              <div className={preview.canApply ? 'wb-note wb-history-result' : 'wb-error'} role="status">
                <strong>{preview.canApply ? '可应用' : '无法应用'}</strong>
                <p>{preview.message ?? (preview.contentChanged ? '文件内容发生变化，请调整顺序后重试。' : '文件内容不变。')}</p>
                {preview.conflicts.map((path) => (
                  <code key={path}>{path}</code>
                ))}
                {preview.canApply && (
                  <ol>
                    {preview.commits.map((commit) => (
                      <li key={commit.source}>
                        <span>{commit.message.split('\n')[0]}</span>
                        <code>
                          {commit.source.slice(0, 8)} → {commit.sha.slice(0, 8)}
                        </code>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
            <p className="muted small">应用将改写 {draftBranch} 的提交历史，不自动推送。</p>
            <div className="wb-history-actions">
              <Button
                variant="ghost"
                size="icon"
                aria-label="丢弃草稿"
                title="丢弃草稿"
                disabled={pending}
                onClick={() => {
                  setDraft(null);
                  setPreview(null);
                  setError(null);
                }}
              >
                <Trash2 size={16} aria-hidden="true" />
              </Button>
              <span className="spacer" />
              <Button variant="outline" disabled={pending || stale || draft.commits.some((commit) => !commit.message.trim())} onClick={() => void inspect()}>
                {pending ? '处理中…' : '预览改写'}
              </Button>
              {preview?.canApply && (
                <Button disabled={pending || stale || !!errors.history} onClick={() => void apply()}>
                  应用到 {history?.branch}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
