import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
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
      <Textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label={title}
        placeholder="输入内容（支持 Markdown）"
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
        <Button
          variant="default"
          size="icon-sm"
          className="primary"
          onClick={() => void submit()}
          disabled={!body.trim() || busy}
          title={`${submitLabel}（Ctrl+Enter）`}
        >
          <ActionIcon name={busy ? 'loading' : 'save'} label={submitLabel} />
        </Button>
        <Button variant="outline" size="icon-sm" onClick={onCancel} title="取消（Esc）">
          <ActionIcon name="close" label="取消" />
        </Button>
      </div>
    </div>
  );
}
