import { useState } from 'react';
import { ActionIcon } from './ActionIcon';
import type { Comment, TargetKey } from '@warden/shared';
import { awaitsReviewer, targetLabel, tryParseTargetKey } from '@warden/shared';
import { branchOf, useStore } from '../store';
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
  const replyToComment = useStore((s) => s.replyToComment);
  const exportComments = useStore((s) => s.exportComments);
  const focused = useStore((s) => s.focusedCommentId === comment.id);
  const focusComment = useStore((s) => s.focusComment);
  const targetKey = useStore((s) => s.targetKey);
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [picking, setPicking] = useState(false);
  const linkComment = useStore((s) => s.linkComment);
  const repo = useStore((s) => s.repo);
  const root = useStore((s) => s.root);
  const todos = useStore((s) => s.todos);
  const branch = branchOf(repo, root);
  // Open todos of the branch in front that do not carry this comment yet: where it can still go.
  const openTodos = todos.filter((t) => t.branch === branch && t.status === 'open' && !t.commentIds?.includes(comment.id));
  const answered = awaitsReviewer(comment);

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
          <span className="comment-line">
            {showFile ? ':' : '行 '}
            {range}
          </span>
        </span>
        {comment.side === 'old' && <span className="badge">修改前</span>}
        {answered ? (
          <span className="badge badge-active" title="agent 已回复，等你确认或追问">
            待确认
          </span>
        ) : (
          comment.status === 'exported' && (
            <span className="badge badge-exported" title="这条评论已复制，或已由 agent 通过 warden feedback 取走">
              已导出
            </span>
          )
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
          {/* Accepting the answer ends the conversation, and the comment with it: there is
              nothing left for it to ask. */}
          {answered && (
            <button
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                void deleteComment(comment.id);
              }}
              title="接受 agent 的回复并删除这条评论"
            >
              <ActionIcon name="check" label="解决" />
            </button>
          )}
          {comment.replies?.length ? (
            <button
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                setReplying(true);
              }}
              title="追问：回复会在下次导出时交给 agent"
            >
              <ActionIcon name="reply" label="回复" />
            </button>
          ) : null}
          <button
            className="link"
            aria-expanded={picking}
            onClick={(e) => {
              e.stopPropagation();
              setPicking((v) => !v);
            }}
            title="让这条评论随一条待办交给 agent"
          >
            <ActionIcon name="todos" label="加入待办" />
          </button>
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
      {picking && (
        // Stops here so picking a todo does not also focus the card, which would scroll the diff to it.
        <div className="todo-pick" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="link"
            onClick={() => {
              setPicking(false);
              void linkComment(comment.id, null);
            }}
          >
            <ActionIcon name="add" label="新建待办" />
          </button>
          {openTodos.map((t) => (
            <button
              key={t.id}
              type="button"
              className="link todo-pick-item"
              onClick={() => {
                setPicking(false);
                void linkComment(comment.id, t.id);
              }}
              title={`加入「${t.title}」`}
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
      {showSnippet && comment.codeSnippet.length > 0 && (
        <pre className="snippet">
          {comment.codeSnippet.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Snippet line numbers are fixed within this comment snapshot.
            <div key={`${comment.id}:${comment.startLine + i}`}>
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
      {comment.replies?.map((r) => (
        <div key={r.id} className={`comment-reply reply-${r.author}`}>
          <div className="comment-reply-head">
            <span>{r.author === 'agent' ? 'Agent' : '我'}</span>
            <span className="muted time" title={fmtTime(r.at)}>
              {shortTime(r.at)}
            </span>
          </div>
          <Markdown text={r.body} />
        </div>
      ))}
      {replying && (
        <CommentEditor
          title="追问"
          submitLabel="发送"
          onSave={async (body) => {
            if (await replyToComment(comment.id, body)) setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      )}
    </div>
  );
}
