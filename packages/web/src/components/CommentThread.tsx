import { useState } from 'react';
import type { Comment } from '@warden/shared';
import { useStore } from '../store';
import { Markdown } from './Markdown';
import { CommentEditor } from './CommentEditor';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function CommentCard({ comment, showSnippet = false }: { comment: Comment; showSnippet?: boolean }) {
  const updateComment = useStore((s) => s.updateComment);
  const deleteComment = useStore((s) => s.deleteComment);
  const exportComments = useStore((s) => s.exportComments);
  const selected = useStore((s) => s.selectedCommentIds.includes(comment.id));
  const toggleSelect = useStore((s) => s.toggleSelectComment);
  const setReattaching = useStore((s) => s.setReattaching);
  const reattaching = useStore((s) => s.reattaching === comment.id);
  const [editing, setEditing] = useState(false);

  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
  return (
    <div className={`comment-card status-${comment.status} ${selected ? 'selected' : ''}`}>
      <div className="comment-head">
        <label className="check" title="选中以创建 / 关联 Issue">
          <input type="checkbox" checked={selected} onChange={() => toggleSelect(comment.id)} />
        </label>
        <span className="mono">
          {comment.side} {range}
        </span>
        <span className={`badge badge-${comment.status}`}>{comment.status}</span>
        <span className="muted time" title={`created ${fmtTime(comment.createdAt)}${comment.exportedAt ? `\nexported ${fmtTime(comment.exportedAt)}` : ''}`}>
          {fmtTime(comment.updatedAt)}
        </span>
        <span className="spacer" />
        {comment.status === 'orphaned' && (
          <button className={`link ${reattaching ? 'active' : ''}`} onClick={() => setReattaching(reattaching ? null : comment.id)}>
            {reattaching ? '取消重附着' : '重新附着到选区'}
          </button>
        )}
        <button className="link" onClick={() => void exportComments([comment.id])}>
          复制此条
        </button>
        <button className="link" onClick={() => setEditing(true)}>
          编辑
        </button>
        <button
          className="link danger"
          onClick={() => {
            if (window.confirm('删除这条评论？')) void deleteComment(comment.id);
          }}
        >
          删除
        </button>
      </div>
      {showSnippet && comment.codeSnippet.length > 0 && (
        <pre className="snippet">
          {comment.codeSnippet.map((l, i) => (
            <div key={i}>
              <span className="ln">{comment.startLine + i}</span>
              {l}
            </div>
          ))}
        </pre>
      )}
      {editing ? (
        <CommentEditor
          title="编辑评论"
          initial={comment.body}
          onSave={async (body) => {
            await updateComment(comment.id, { body });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown text={comment.body} />
      )}
    </div>
  );
}

export function CommentThread({ comments }: { comments: Comment[] }) {
  return (
    <div className="comment-thread" onMouseDown={(e) => e.stopPropagation()}>
      {comments.map((c) => (
        <CommentCard key={c.id} comment={c} />
      ))}
    </div>
  );
}
