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

/** Compact time for the rail: today -> HH:MM, otherwise M/D. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

export function CommentCard({ comment, showSnippet = false, showFile = false }: { comment: Comment; showSnippet?: boolean; showFile?: boolean }) {
  const updateComment = useStore((s) => s.updateComment);
  const deleteComment = useStore((s) => s.deleteComment);
  const exportComments = useStore((s) => s.exportComments);
  const selected = useStore((s) => s.selectedCommentIds.includes(comment.id));
  const toggleSelect = useStore((s) => s.toggleSelectComment);
  const setReattaching = useStore((s) => s.setReattaching);
  const reattaching = useStore((s) => s.reattaching === comment.id);
  const focused = useStore((s) => s.focusedCommentId === comment.id);
  const focusComment = useStore((s) => s.focusComment);
  const [editing, setEditing] = useState(false);

  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
  return (
    <div
      className={`comment-card status-${comment.status} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
      onClick={() => {
        if (!focused) void focusComment(comment.id);
      }}
    >
      <div className="comment-head">
        {showFile && (
          <span className="mono file" title={comment.filePath}>
            {comment.filePath.split('/').pop()}
          </span>
        )}
        <label className="check" title="选中以创建 / 关联 Issue" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={() => toggleSelect(comment.id)} />
        </label>
        <span className="mono">
          {comment.side} {range}
        </span>
        <span className={`badge badge-${comment.status}`}>{comment.status}</span>
        <span className="muted time" title={`created ${fmtTime(comment.createdAt)}${comment.exportedAt ? `\nexported ${fmtTime(comment.exportedAt)}` : ''}`}>
          {shortTime(comment.updatedAt)}
        </span>
        <span className="spacer" />
        {comment.status === 'orphaned' && (
          <button
            className={`link ${reattaching ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setReattaching(reattaching ? null : comment.id);
            }}
          >
            {reattaching ? '取消重附着' : '重新附着到选区'}
          </button>
        )}
        <button
          className="link"
          onClick={(e) => {
            e.stopPropagation();
            void exportComments([comment.id]);
          }}
          title="复制此条评论"
        >
          复制
        </button>
        <button
          className="link"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          编辑
        </button>
        <button
          className="link danger"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm('删除这条评论？')) void deleteComment(comment.id);
          }}
        >
          删除
        </button>
      </div>
      {(showSnippet || comment.status === 'orphaned') && comment.codeSnippet.length > 0 && (
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

