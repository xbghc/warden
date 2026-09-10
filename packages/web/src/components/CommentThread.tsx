import { useState } from 'react';
import type { Comment, CommentStatus, TargetKey } from '@warden/shared';
import { targetLabel, tryParseTargetKey } from '@warden/shared';
import { useStore } from '../store';
import { Markdown } from './Markdown';
import { CommentEditor } from './CommentEditor';

/** The stored status is a wire value; this is what it is called on the page. */
export const STATUS_LABEL: Record<CommentStatus, string> = { active: '待导出', exported: '已导出', orphaned: '已失联' };

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

/** Short name of the view a comment sits in, for cards showing a comment from another view. */
function viewLabel(key: TargetKey): string {
  const t = tryParseTargetKey(key);
  if (!t) return key;
  if (t.kind === 'working') return 'Unstaged';
  if (t.kind === 'staged') return 'Staged';
  if (t.kind === 'all') return 'All';
  return targetLabel(t);
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
  const targetKey = useStore((s) => s.targetKey);
  const [editing, setEditing] = useState(false);

  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
  // Staging a hunk carries its comments into the Staged view; say so, otherwise the missing
  // marker in the diff in front looks like the comment lost its anchor.
  const elsewhere = comment.status !== 'orphaned' && comment.targetKey !== targetKey ? viewLabel(comment.targetKey) : null;
  return (
    <div
      className={`comment-card status-${comment.status} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''} ${reattaching ? 'reattaching' : ''}`}
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
        {/* Which side of the diff the lines are on, said the way the diff says it. */}
        <span className="mono" title={comment.side === 'old' ? '删除侧的行号' : '新增侧的行号'}>
          {comment.side === 'old' ? '−' : '+'}
          {range}
        </span>
        <span className={`badge badge-${comment.status}`}>{STATUS_LABEL[comment.status]}</span>
        {elsewhere && (
          <span className="badge" title={`这条评论现在位于 ${comment.targetKey}，点击卡片可跳转`}>
            {elsewhere}
          </span>
        )}
        <span className="muted time" title={`created ${fmtTime(comment.createdAt)}${comment.exportedAt ? `\nexported ${fmtTime(comment.exportedAt)}` : ''}`}>
          {shortTime(comment.updatedAt)}
        </span>
        <span className="card-actions">
          {comment.status === 'orphaned' && (
            <button
              className={`link ${reattaching ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setReattaching(reattaching ? null : comment.id);
              }}
            >
              {reattaching ? '取消重附着' : '重新附着'}
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
        </span>
      </div>
      {(showSnippet || comment.status === 'orphaned') && comment.codeSnippet.length > 0 && (
        <pre className="snippet">
          {comment.codeSnippet.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: snippet lines have no identity beyond their position
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
