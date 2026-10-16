import { useState } from 'react';
import { ArrowDown, ArrowUp, GitCommitHorizontal, GripVertical, RefreshCw } from 'lucide-react';
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
      setError('原起点已不在当前历史中。请丢弃草稿后重新选择范围。');
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
      setNotice('已应用新的提交顺序与说明。');
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
          <p>{draft ? '调整提交顺序与说明。实际分支在应用前保持原样。' : '查看需求由哪些提交组成，再按需要调整真实历史。'}</p>
        </div>
        <Button variant="outline" size="sm" disabled={checking || pending} onClick={() => void useWorkbenchData.getState().refresh()}>
          <RefreshCw size={14} />
          刷新历史
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
            <div className="wb-section-heading">
              <h2>提交顺序：早 → 晚</h2>
              <span>{history?.commits.length ?? 0} 个提交</span>
            </div>
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
                      {commit.deliveryId && ' · 已记录交付'} · {new Date(commit.date).toLocaleDateString('zh-CN')}
                    </small>
                  </div>
                  <code>{commit.sha.slice(0, 8)}</code>
                  <span className="wb-history-index">{index + 1}</span>
                </li>
              ))}
            </ol>
            {!history?.commits.length && <div className="wb-empty-inline">主开发分支暂无可显示的提交。</div>}
            <div className="wb-history-range">
              <label className="wb-field">
                编排范围
                <NativeSelect aria-label="历史编排起点" value={start} onChange={(event) => setStart(event.target.value)}>
                  <option value="">选择起点提交</option>
                  {history?.commits.map((commit) => (
                    <option key={commit.sha} value={commit.sha}>
                      {commit.sha.slice(0, 8)} · {commit.message.split('\n')[0]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <p className="muted small">从所选提交到当前分支末端。本版仅支持线性历史，不合并提交、不自动推送。</p>
              <Button disabled={!start || !history || !!errors.history} onClick={create}>
                编排所选历史
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="wb-draft-meta">
              <span>
                基于 <code>{draft.head.slice(0, 8)}</code>
              </span>
              <span>{draft.commits.length} 个提交 · 不合并提交</span>
              <span>实际分支尚未改变</span>
            </div>
            {stale && (
              <div className="wb-error">
                <strong>{differentBranch ? `主开发分支已切换。此草稿属于 ${draftBranch}。` : '主开发分支已有新提交或已被改写。'}</strong>
                <p>此草稿未包含最新历史，不能直接应用。</p>
                <Button size="sm" variant="outline" onClick={rebuild} disabled={pending || differentBranch}>
                  基于最新历史重建草稿
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
                        disabled={pending || index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        <ArrowUp size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`下移提交 ${index + 1}`}
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
                <strong>{preview.canApply ? '预览成功' : '此候选不能应用'}</strong>
                <p>{preview.message ?? (preview.contentChanged ? '最终文件内容与原历史不同，本次候选不会应用。' : '最终文件内容与原历史一致。')}</p>
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
            <div className="wb-history-actions">
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setDraft(null);
                  setPreview(null);
                  setError(null);
                }}
              >
                丢弃草稿
              </Button>
              <span className="spacer" />
              <Button variant="outline" disabled={pending || stale || draft.commits.some((commit) => !commit.message.trim())} onClick={() => void inspect()}>
                {pending ? '处理中…' : '预览改写结果'}
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
