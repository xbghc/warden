import { useMemo } from 'react';
import { ActionIcon } from './ActionIcon';
import type { Comment } from '@warden/shared';
import { useStore, type RailFilter } from '../store';
import { CommentCard } from './CommentThread';
import { CommentEditor } from './CommentEditor';

function orderKey(c: Comment): [string, number, number] {
  return [c.filePath, c.side === 'old' ? 0 : 1, c.endLine];
}

function compare(a: Comment, b: Comment): number {
  const [fa, sa, la] = orderKey(a);
  const [fb, sb, lb] = orderKey(b);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (la !== lb) return la - lb;
  return sa - sb;
}

/** Right-hand rail: comments in file/line order, plus the editor for the current selection. */
export function CommentRail() {
  const comments = useStore((s) => s.comments);
  const activeFile = useStore((s) => s.activeFile);
  const filter = useStore((s) => s.railFilter);
  const setFilter = useStore((s) => s.setRailFilter);
  const editor = useStore((s) => s.editor);
  const setEditor = useStore((s) => s.setEditor);
  const createComment = useStore((s) => s.createComment);
  const copyAll = useStore((s) => s.copyAllComments);
  const includeExported = useStore((s) => s.includeExported);
  const setIncludeExported = useStore((s) => s.setIncludeExported);

  const counts = useMemo(
    () => ({
      file: comments.filter((c) => c.filePath === activeFile).length,
      all: comments.length,
      unexported: comments.filter((c) => c.status === 'active').length,
    }),
    [comments, activeFile],
  );

  const shown = useMemo(() => {
    let list = comments;
    if (filter === 'file') list = list.filter((c) => c.filePath === activeFile);
    else if (filter === 'unexported') list = list.filter((c) => c.status === 'active');
    return list.slice().sort(compare);
  }, [comments, filter, activeFile]);

  // The editor card sits where the new comment will land in the attached order.
  const editorIndex = useMemo(() => {
    if (!editor) return -1;
    if (filter === 'file' && editor.filePath !== activeFile) return -1;
    const probe = { filePath: editor.filePath, side: editor.side, endLine: editor.endLine } as Comment;
    let i = 0;
    while (i < shown.length && compare(shown[i]!, probe) <= 0) i++;
    return i;
  }, [editor, shown, filter, activeFile]);

  const unexported = counts.unexported + (includeExported ? comments.filter((c) => c.status === 'exported').length : 0);
  const showFile = filter !== 'file';
  const filters: [RailFilter, string, number][] = [
    ['file', '此文件', counts.file],
    ['all', '全部', counts.all],
    ['unexported', '未导出', counts.unexported],
  ];

  const editorCard = editor && (
    <CommentEditor
      key={`${editor.filePath}:${editor.side}:${editor.startLine}:${editor.endLine}`}
      title={`${editor.filePath.split('/').pop()} ${editor.side} ${editor.startLine === editor.endLine ? editor.startLine : `${editor.startLine}-${editor.endLine}`}`}
      onSave={async (body) => {
        await createComment({ filePath: editor.filePath, side: editor.side, startLine: editor.startLine, endLine: editor.endLine, body });
      }}
      onCancel={() => setEditor(null)}
    />
  );

  return (
    <>
      <div className="rail-tools">
        <div className="seg small">
          {filters.map(([key, label, n]) => (
            <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label} {n}
            </button>
          ))}
        </div>
        <span className="spacer" />
      </div>
      <div className="rail-list">
        {shown.map((c, i) => (
          <div key={c.id} className="rail-slot">
            {editorIndex === i && editorCard}
            <CommentCard comment={c} showFile={showFile} />
          </div>
        ))}
        {editor && editorIndex === shown.length && editorCard}
        {editor && editorIndex === -1 && editorCard}
        {counts.all === 0 && !editor && (
          <div className="muted empty">
            还没有评论。在 diff 行旁点击 <span className="add-btn static">+</span> 或拖选多行开始。
          </div>
        )}
        {counts.all > 0 && shown.length === 0 && !editor && <div className="muted empty">没有符合筛选的评论</div>}
      </div>
      <div className="rail-foot">
        <div className="rail-foot-row">
          <button className="primary" onClick={() => void copyAll()} disabled={unexported === 0}>
            <ActionIcon name="copy" label={`复制评论${counts.unexported > 0 ? ` (${counts.unexported} 未导出)` : ''}`} count={counts.unexported} />
          </button>
          <label className="check">
            <input type="checkbox" checked={includeExported} onChange={(e) => setIncludeExported(e.target.checked)} />
            <ActionIcon name="checked" label="含已导出" />
          </label>
        </div>
      </div>
    </>
  );
}
