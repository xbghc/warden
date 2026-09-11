import { useState } from 'react';
import { ActionIcon } from './ActionIcon';
import type { Comment, TargetKey } from '@warden/shared';
import { targetLabel, tryParseTargetKey } from '@warden/shared';
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
  const focused = useStore((s) => s.focusedCommentId === comment.id);
  const focusComment = useStore((s) => s.focusComment);
  const targetKey = useStore((s) => s.targetKey);
  const [editing, setEditing] = useState(false);

  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}–${comment.endLine}`;
  const location = `${comment.filePath} · ${comment.side === 'old' ? '修改前' : '修改后'}第 ${range} 行`;
  // Staging a hunk carries its comments into the Staged view; say so, otherwise the missing
  // marker in the diff in front looks like the comment lost its anchor.
  const elsewhere = comment.status !== 'orphaned' && comment.targetKey !== targetKey ? viewLabel(comment.targetKey) : null;
  return (
    <div
      className={`comment-card ${focused ? 'focused' : ''}`}
      onClick={() => {
        if (!focused) void focusComment(comment.id);
      }}
    >
      <div className="comment-head">
        <span className="mono comment-location" title={location} aria-label={location}>
          {showFile && <span className="file">{comment.filePath.split('/').pop()}</span>}
          <span className="comment-line">{showFile ? ':' : '行 '}{range}</span>
        </span>
        {comment.side === 'old' && <span className="badge">修改前</span>}
        {comment.status === 'exported' && (
          <span className="badge badge-exported" title="这条评论已复制导出">
            已复制
          </span>
        )}
        {elsewhere && (
          <span className="badge" title={`这条评论现在位于 ${comment.targetKey}，点击卡片可跳转`}>
            {elsewhere}
          </span>
        )}
        <span className="muted time" title={`created ${fmtTime(comment.createdAt)}${comment.exportedAt ? `\nexported ${fmtTime(comment.exportedAt)}` : ''}`}>
          {shortTime(comment.updatedAt)}
        </span>
        <span className="card-actions">
          <button
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              void exportComments([comment.id]);
            }}
            title="复制此条评论"
          >
            <ActionIcon name="copy" label="复制" />
          </button>
          <button
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <ActionIcon name="edit" label="编辑" />
          </button>
          <button
            className="link danger"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm('删除这条评论？')) void deleteComment(comment.id);
            }}
          >
            <ActionIcon name="delete" label="删除" />
          </button>
        </span>
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
