import { useEffect, useRef, useState } from 'react';
import { ActionIcon } from './ActionIcon';

interface Props {
  title: string;
  initial?: string;
  submitLabel?: string;
  onSave: (body: string) => Promise<void> | void;
  onCancel: () => void;
}

export function CommentEditor({ title, initial = '', submitLabel = '保存评论', onSave, onCancel }: Props) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-editor" onMouseDown={(e) => e.stopPropagation()}>
      <div className="comment-editor-head">{title}</div>
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="写评论，支持 Markdown。Ctrl+Enter 保存，Esc 取消。"
        rows={4}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
          e.stopPropagation();
        }}
      />
      <div className="comment-editor-actions">
        <button className="primary" onClick={() => void submit()} disabled={!body.trim() || busy}>
          <ActionIcon name={busy ? 'loading' : 'save'} label={submitLabel} />
        </button>
        <button onClick={onCancel}><ActionIcon name="close" label="取消" /></button>
      </div>
    </div>
  );
}
