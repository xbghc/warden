import { useEffect, useMemo, useState } from 'react';
import type { Comment, Issue } from '@warden/shared';
import { useStore } from '../store';
import { Markdown } from './Markdown';

type Filter = 'open' | 'closed' | 'all';

function LinkedComment({ comment, onUnlink }: { comment: Comment; onUnlink: () => void }) {
  const jump = useStore((s) => s.jumpToComment);
  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
  return (
    <div className={`linked-comment status-${comment.status}`}>
      <div className="linked-head">
        <span className="mono">
          {comment.filePath}:{range} ({comment.side})
        </span>
        <span className={`badge badge-${comment.status}`}>{comment.status}</span>
        <span className="muted mono small" title={comment.targetKey}>
          {comment.targetKey.length > 28 ? comment.targetKey.slice(0, 28) + '…' : comment.targetKey}
        </span>
        <span className="spacer" />
        {comment.status !== 'orphaned' && (
          <button className="link" onClick={() => void jump(comment)}>
            跳转
          </button>
        )}
        <button className="link danger" onClick={onUnlink}>
          解除关联
        </button>
      </div>
      <div className="linked-body">{comment.body}</div>
    </div>
  );
}

function IssueDetail({ issue, onBack }: { issue: Issue; onBack: () => void }) {
  const allComments = useStore((s) => s.allComments);
  const currentComments = useStore((s) => s.comments);
  const updateIssue = useStore((s) => s.updateIssue);
  const deleteIssue = useStore((s) => s.deleteIssue);
  const exportIssue = useStore((s) => s.exportIssue);
  const selectedIds = useStore((s) => s.selectedCommentIds);
  const clearSelected = useStore((s) => s.clearSelectedComments);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body);

  const byId = useMemo(() => {
    const m = new Map<string, Comment>();
    for (const c of allComments) m.set(c.id, c);
    for (const c of currentComments) m.set(c.id, c);
    return m;
  }, [allComments, currentComments]);

  const addable = selectedIds.filter((id) => !issue.commentIds.includes(id));

  return (
    <div className="issue-detail">
      <div className="issue-detail-head">
        <button className="link" onClick={onBack}>
          ← 返回列表
        </button>
        <span className="spacer" />
        <button className="link" onClick={() => void exportIssue(issue.id)}>
          复制 Issue
        </button>
        <button className="link" onClick={() => void updateIssue(issue.id, { status: issue.status === 'open' ? 'closed' : 'open' })}>
          {issue.status === 'open' ? '关闭' : '重新打开'}
        </button>
        <button
          className="link danger"
          onClick={() => {
            if (window.confirm(`删除 Issue「${issue.title}」？`)) {
              void deleteIssue(issue.id);
              onBack();
            }
          }}
        >
          删除
        </button>
      </div>
      {editing ? (
        <div className="issue-form">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="描述（Markdown）" />
          <div className="row-actions">
            <button
              className="primary"
              disabled={!title.trim()}
              onClick={async () => {
                await updateIssue(issue.id, { title, body });
                setEditing(false);
              }}
            >
              保存
            </button>
            <button onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <>
          <h3>
            <span className={`badge badge-${issue.status}`}>{issue.status}</span> {issue.title}
            <button className="link" onClick={() => setEditing(true)}>
              编辑
            </button>
          </h3>
          {issue.body ? <Markdown text={issue.body} /> : <p className="muted">（无描述）</p>}
        </>
      )}
      <div className="issue-comments">
        <div className="section-title">
          关联评论 ({issue.commentIds.length})
          {addable.length > 0 && (
            <button
              className="link"
              onClick={async () => {
                await updateIssue(issue.id, { commentIds: [...issue.commentIds, ...addable] });
                clearSelected();
              }}
            >
              + 添加选中的 {addable.length} 条评论
            </button>
          )}
        </div>
        {issue.commentIds.map((id) => {
          const c = byId.get(id);
          const unlink = () => void updateIssue(issue.id, { commentIds: issue.commentIds.filter((x) => x !== id) });
          if (!c)
            return (
              <div key={id} className="linked-comment muted">
                评论 {id.slice(0, 8)} 已不存在{' '}
                <button className="link" onClick={unlink}>
                  移除
                </button>
              </div>
            );
          return <LinkedComment key={id} comment={c} onUnlink={unlink} />;
        })}
      </div>
    </div>
  );
}

export function IssuesDrawer() {
  const issues = useStore((s) => s.issues);
  const loadIssues = useStore((s) => s.loadIssues);
  const createIssue = useStore((s) => s.createIssue);
  const selectedIds = useStore((s) => s.selectedCommentIds);
  const clearSelected = useStore((s) => s.clearSelectedComments);
  const setPanel = useStore((s) => s.setPanel);
  const [filter, setFilter] = useState<Filter>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);
  useEffect(() => {
    if (selectedIds.length > 0 && !openId) setCreating(true);
  }, [selectedIds.length, openId]);

  const shown = issues.filter((i) => filter === 'all' || i.status === filter);
  const open = openId ? issues.find((i) => i.id === openId) : undefined;

  return (
    <aside className="issues-drawer">
      <div className="drawer-head">
        <strong>Issues</strong>
        <div className="seg">
          {(['open', 'closed', 'all'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button onClick={() => setCreating(true)}>新建</button>
        <button className="icon" onClick={() => setPanel('diff')} title="关闭 (Esc)">
          ✕
        </button>
      </div>
      {open ? (
        <IssueDetail issue={open} onBack={() => setOpenId(null)} />
      ) : (
        <>
          {creating && (
            <div className="issue-form">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" autoFocus />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="描述（Markdown，可选）" />
              {selectedIds.length > 0 && <div className="muted">将关联 {selectedIds.length} 条选中的评论</div>}
              <div className="row-actions">
                <button
                  className="primary"
                  disabled={!title.trim()}
                  onClick={async () => {
                    const issue = await createIssue({ title, body, commentIds: selectedIds });
                    if (issue) {
                      setTitle('');
                      setBody('');
                      setCreating(false);
                      setOpenId(issue.id);
                    }
                  }}
                >
                  创建 Issue
                </button>
                <button
                  onClick={() => {
                    setCreating(false);
                    clearSelected();
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          <div className="issue-list">
            {shown.length === 0 && <div className="muted empty">没有 {filter === 'all' ? '' : filter} Issue</div>}
            {shown.map((i) => (
              <div key={i.id} className="issue-row" onClick={() => setOpenId(i.id)}>
                <span className={`badge badge-${i.status}`}>{i.status}</span>
                <span className="title">{i.title}</span>
                <span className="muted">{i.commentIds.length} 评论</span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
