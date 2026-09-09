import { useEffect, useMemo, useState } from 'react';
import type { Comment, Issue } from '@warden/shared';
import { useStore } from '../store';
import { TaskList } from './TaskList';

/** A comment linked to an issue: shown under the open row the way a subtask sits under its task. */
function LinkedComment({ comment, onUnlink }: { comment: Comment; onUnlink: () => void }) {
  const jump = useStore((s) => s.jumpToComment);
  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
  return (
    <div className={`task-sub status-${comment.status}`}>
      <span className="task-sub-dot" />
      <div className="task-sub-main">
        <div className="task-sub-head">
          <span className="mono" title={`${comment.filePath} (${comment.side})`}>
            {comment.filePath.split('/').pop()}:{range}
          </span>
          <span className={`badge badge-${comment.status}`}>{comment.status}</span>
          <span className="task-actions">
            {comment.status !== 'orphaned' && (
              <button type="button" className="link" onClick={() => void jump(comment)}>
                跳转
              </button>
            )}
            <button type="button" className="link danger" onClick={onUnlink}>
              解除关联
            </button>
          </span>
        </div>
        <div className="task-sub-body">{comment.body}</div>
      </div>
    </div>
  );
}

function IssueLinks({ issue, byId }: { issue: Issue; byId: Map<string, Comment> }) {
  const updateIssue = useStore((s) => s.updateIssue);
  const selectedIds = useStore((s) => s.selectedCommentIds);
  const clearSelected = useStore((s) => s.clearSelectedComments);
  const addable = selectedIds.filter((id) => !issue.commentIds.includes(id));
  const unlink = (id: string) => void updateIssue(issue.id, { commentIds: issue.commentIds.filter((x) => x !== id) });
  return (
    <div className="task-subs">
      {issue.commentIds.map((id) => {
        const c = byId.get(id);
        if (!c)
          return (
            <div key={id} className="task-sub muted">
              评论 {id.slice(0, 8)} 已不存在
              <button type="button" className="link" onClick={() => unlink(id)}>
                移除
              </button>
            </div>
          );
        return <LinkedComment key={id} comment={c} onUnlink={() => unlink(id)} />;
      })}
      {addable.length > 0 && (
        <button
          type="button"
          className="link task-sub-add"
          onClick={async () => {
            await updateIssue(issue.id, { commentIds: [...issue.commentIds, ...addable] });
            clearSelected();
          }}
        >
          + 关联选中的 {addable.length} 条评论
        </button>
      )}
      {issue.commentIds.length === 0 && addable.length === 0 && <div className="task-sub-none">没有关联评论。在评论卡片上勾选几条，再回到这里关联。</div>}
    </div>
  );
}

export function IssuesDrawer() {
  const issues = useStore((s) => s.issues);
  const loadIssues = useStore((s) => s.loadIssues);
  const createIssue = useStore((s) => s.createIssue);
  const updateIssue = useStore((s) => s.updateIssue);
  const deleteIssue = useStore((s) => s.deleteIssue);
  const deleteIssues = useStore((s) => s.deleteIssues);
  const moveIssue = useStore((s) => s.moveIssue);
  const exportIssue = useStore((s) => s.exportIssue);
  const selectedIds = useStore((s) => s.selectedCommentIds);
  const clearSelected = useStore((s) => s.clearSelectedComments);
  const setPanel = useStore((s) => s.setPanel);
  const allComments = useStore((s) => s.allComments);
  const currentComments = useStore((s) => s.comments);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);
  // Arriving with comments ticked means "make an issue of these": the add row is already open.
  useEffect(() => {
    if (selectedIds.length > 0) setAdding(true);
  }, [selectedIds.length]);

  const byId = useMemo(() => {
    const m = new Map<string, Comment>();
    for (const c of allComments) m.set(c.id, c);
    for (const c of currentComments) m.set(c.id, c);
    return m;
  }, [allComments, currentComments]);
  const items = useMemo(() => issues.map((i) => ({ ...i, done: i.status === 'closed' })), [issues]);
  const openCount = items.filter((i) => !i.done).length;

  return (
    <aside className="issues-drawer">
      <div className="drawer-head">
        <span className="drawer-title">Issues</span>
        <span className="muted">{openCount} open</span>
        <span className="spacer" />
        <button className="icon" onClick={() => setPanel('diff')} title="关闭 (Esc)">
          ✕
        </button>
      </div>
      <div className="rail-list tasks">
        <button type="button" className="task-add" onClick={() => setAdding(true)} title="添加一个 Issue（回车可以连着写）">
          <span className="task-add-plus">+</span>
          添加 Issue
        </button>
        <TaskList
          items={items}
          adding={adding}
          onAddingChange={(v) => {
            setAdding(v);
            // Backing out of the add row lets go of the ticked comments too.
            if (!v) clearSelected();
          }}
          addHint={selectedIds.length > 0 ? `将关联 ${selectedIds.length} 条选中的评论` : undefined}
          titlePlaceholder="标题"
          doneLabel="已关闭"
          emptyText="还没有 Issue。在评论卡片上勾选几条，或点上面的“添加 Issue”。"
          allDoneText="没有打开的 Issue"
          onCreate={(title, after) => createIssue({ title, body: '', commentIds: selectedIds, after })}
          onUpdate={(id, patch) => updateIssue(id, patch)}
          onToggle={(id, done) => updateIssue(id, { status: done ? 'closed' : 'open' })}
          onDelete={deleteIssue}
          onMove={moveIssue}
          onClearDone={() => deleteIssues(items.filter((i) => i.done).map((i) => i.id))}
          meta={(i) =>
            i.commentIds.length > 0 ? (
              <span className="task-count" title="关联的评论数">
                {i.commentIds.length} 评论
              </span>
            ) : null
          }
          actions={(i) => (
            <button type="button" className="link" onClick={() => void exportIssue(i.id)} title="把 Issue 和它的评论复制为 agent 可读的提示词">
              复制
            </button>
          )}
          extra={(i) => <IssueLinks issue={i} byId={byId} />}
        />
      </div>
    </aside>
  );
}
