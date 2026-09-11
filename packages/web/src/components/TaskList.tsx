import { ActionIcon } from './ActionIcon';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Markdown } from './Markdown';

/**
 * A checklist that behaves like Google Tasks: an "add" row at the top, titles and details edited
 * in place, Enter at the end of a row starting the next one, a circle that strikes the row
 * through and files it under a collapsed "done" section, and rows dragged into the order the
 * reviewer wants. Todos and issues are both this list with different trimmings.
 */
export interface TaskItem {
  id: string;
  title: string;
  body: string;
  done: boolean;
}

export interface TaskListProps<T extends TaskItem> {
  items: T[];
  /** The add row is open; the parent owns the flag so a button outside the list can open it. */
  adding: boolean;
  onAddingChange(v: boolean): void;
  /** Shown under the add row, e.g. what the new item will be linked to. */
  addHint?: ReactNode;
  titlePlaceholder: string;
  /** Heading of the collapsed section at the bottom: 已完成 / 已关闭. */
  doneLabel: string;
  emptyText: ReactNode;
  allDoneText: ReactNode;
  /** Resolves to the new item (its id is where the next row goes) or undefined when it failed. */
  onCreate(title: string, after?: string): Promise<{ id: string } | undefined>;
  onUpdate(id: string, patch: { title?: string; body?: string }): Promise<void>;
  onToggle(id: string, done: boolean): Promise<void>;
  onDelete(id: string): Promise<void>;
  onMove(id: string, before: string | null): Promise<void>;
  onClearDone?(): Promise<void>;
  /** Inline after the title: badges, counts. */
  meta?(item: T): ReactNode;
  /** Under the details while the row is open: the issue's linked comments, say. */
  extra?(item: T): ReactNode;
  /** Hover actions before 删除. */
  actions?(item: T): ReactNode;
}

type Field = 'title' | 'body';
interface FocusRequest {
  id: string;
  field: Field;
}
interface DropTarget {
  id: string;
  pos: 'before' | 'after';
}

const STRIKE_MS = 320;

/** A textarea that grows with its text and otherwise looks like the text itself. */
function AutoTextarea({
  value,
  inputRef,
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; inputRef?: (el: HTMLTextAreaElement | null) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        inputRef?.(el);
      }}
      rows={1}
      value={value}
      className={`task-ta ${className ?? ''}`}
      spellCheck={false}
      {...rest}
    />
  );
}

function Grip() {
  return (
    <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
      {[3, 8, 13].flatMap((y) => [2, 7].map((x) => <circle key={`${x}${y}`} cx={x + 0.5} cy={y} r="1.3" fill="currentColor" />))}
    </svg>
  );
}

interface RowProps<T extends TaskItem> {
  item: T;
  draft?: boolean;
  open: boolean;
  focus: Field | null;
  onFocused(): void;
  onOpen(): void;
  onClose(): void;
  /** Draft: create it. Existing: rename it. */
  onTitle(title: string): Promise<void>;
  onBody(body: string): Promise<void>;
  /** Enter at the end of the title: the next row starts under this one. */
  onEnter(title: string): Promise<void>;
  onBackspaceEmpty(): void;
  onCancel(): void;
  onToggle(): void;
  completing: boolean;
  onDelete(): void;
  meta?: ReactNode;
  extra?: ReactNode;
  actions?: ReactNode;
  titlePlaceholder: string;
  drag: {
    dragging: boolean;
    over: DropTarget['pos'] | null;
    onArm(): void;
    onDisarm(): void;
    armed: boolean;
    onDragStart(e: DragEvent<HTMLDivElement>): void;
    onDragEnd(): void;
    onDragOver(e: DragEvent<HTMLDivElement>): void;
    onDrop(e: DragEvent<HTMLDivElement>): void;
  } | null;
}

function TaskRow<T extends TaskItem>(p: RowProps<T>) {
  const { item } = p;
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  // Anything the server or an undo changed shows up here as soon as it lands.
  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => setBody(item.body), [item.body]);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // Set once Enter/Escape took care of the row, so the blur that follows changes nothing.
  const settled = useRef(false);

  useEffect(() => {
    if (!p.focus) return;
    const el = p.focus === 'title' ? titleRef.current : bodyRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    p.onFocused();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus]);

  const commitTitle = async () => {
    const next = title.trim();
    if (p.draft) {
      if (next) await p.onTitle(next);
      else p.onCancel();
      return;
    }
    if (!next) {
      setTitle(item.title);
      return;
    }
    if (next !== item.title) await p.onTitle(next);
  };
  const commitBody = async () => {
    if (body !== item.body) await p.onBody(body);
  };

  const onTitleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      settled.current = true;
      const next = title.trim();
      if (p.draft && !next) {
        p.onCancel();
        return;
      }
      void p.onEnter(next);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      settled.current = true;
      setTitle(item.title);
      if (p.draft) p.onCancel();
      else e.currentTarget.blur();
    } else if (e.key === 'Backspace' && title === '') {
      e.preventDefault();
      settled.current = true;
      if (p.draft) p.onCancel();
      else p.onBackspaceEmpty();
    }
  };
  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setBody(item.body);
      e.currentTarget.blur();
    }
  };

  const cls = [
    'task-row',
    item.done ? 'done' : '',
    p.open ? 'open' : '',
    p.draft ? 'draft' : '',
    p.completing ? 'completing' : '',
    p.drag?.dragging ? 'dragging' : '',
    p.drag?.over ? `drop-${p.drag.over}` : '',
  ].join(' ');

  return (
    <div
      className={cls}
      draggable={!!p.drag?.armed}
      onDragStart={p.drag?.onDragStart}
      onDragEnd={p.drag?.onDragEnd}
      onDragOver={p.drag?.onDragOver}
      onDrop={p.drag?.onDrop}
      onFocus={p.onOpen}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) p.onClose();
      }}
    >
      {p.drag ? (
        <span className="task-grip" title="拖动排序" onMouseDown={p.drag.onArm} onMouseUp={p.drag.onDisarm}>
          <Grip />
        </span>
      ) : (
        <span className="task-grip" />
      )}
      <button
        type="button"
        className="task-check"
        aria-label={item.done ? '标记为未完成' : '标记为完成'}
        title={item.done ? '标记为未完成' : '标记为完成'}
        disabled={!!p.draft}
        onClick={p.onToggle}
      />
      <div className="task-main">
        <div className="task-line">
          <AutoTextarea
            className="task-title"
            value={title}
            placeholder={p.titlePlaceholder}
            inputRef={(el) => (titleRef.current = el)}
            autoFocus={!!p.draft}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={onTitleKey}
            onBlur={() => {
              if (settled.current) {
                settled.current = false;
                return;
              }
              void commitTitle();
            }}
            aria-label="标题"
          />
          {p.meta}
          {!p.draft && (
            <span className="task-actions">
              {p.actions}
              <button type="button" className="link danger" onClick={p.onDelete}>
                <ActionIcon name="delete" label="删除" />
              </button>
            </span>
          )}
        </div>
        {p.open && !p.draft ? (
          <AutoTextarea
            className="task-body"
            value={body}
            placeholder="详情（Markdown）"
            inputRef={(el) => (bodyRef.current = el)}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onBodyKey}
            onBlur={() => void commitBody()}
            aria-label="详情"
          />
        ) : (
          item.body && (
            <div
              className="task-details"
              onMouseDown={(e) => {
                // Open the row with the caret in the details, unless a link inside was the target.
                if ((e.target as HTMLElement).closest('a')) return;
                e.preventDefault();
                p.onOpen();
                p.onFocused();
                requestAnimationFrame(() => bodyRef.current?.focus());
              }}
            >
              <Markdown text={item.body} />
            </div>
          )
        )}
        {p.open && p.extra}
      </div>
    </div>
  );
}

export function TaskList<T extends TaskItem>(props: TaskListProps<T>) {
  const { items } = props;
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  const [openId, setOpenId] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [completing, setCompleting] = useState<Set<string>>(new Set());
  /** One draft at a time: at the top (after undefined) or under the row Enter was pressed in. */
  const [draft, setDraft] = useState<{ after?: string } | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);

  useEffect(() => {
    if (props.adding) setDraft({});
    else setDraft((d) => (d && d.after === undefined ? null : d));
  }, [props.adding]);
  const closeDraft = () => {
    setDraft(null);
    props.onAddingChange(false);
  };

  const toggle = (item: T) => {
    if (item.done) {
      void props.onToggle(item.id, false);
      return;
    }
    // Strike it through first, then let it move down: the eye follows what happened. The row
    // closes on its way: a finished item does not sit there with its details open.
    setOpenId((cur) => (cur === item.id ? null : cur));
    setCompleting((s) => new Set(s).add(item.id));
    setTimeout(() => {
      void props.onToggle(item.id, true).finally(() =>
        setCompleting((s) => {
          const n = new Set(s);
          n.delete(item.id);
          return n;
        }),
      );
    }, STRIKE_MS);
  };

  const remove = (item: T) => {
    const idx = open.findIndex((i) => i.id === item.id);
    void props.onDelete(item.id);
    const prev = idx > 0 ? open[idx - 1] : undefined;
    if (prev) setFocusReq({ id: prev.id, field: 'title' });
  };

  const dragProps = (item: T): RowProps<T>['drag'] => ({
    armed: armedId === item.id,
    dragging: dragId === item.id,
    over: over?.id === item.id ? over.pos : null,
    onArm: () => setArmedId(item.id),
    onDisarm: () => setArmedId(null),
    onDragStart: (e) => {
      setDragId(item.id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    },
    onDragEnd: () => {
      setDragId(null);
      setOver(null);
      setArmedId(null);
    },
    onDragOver: (e) => {
      if (!dragId || dragId === item.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = e.currentTarget.getBoundingClientRect();
      const pos: DropTarget['pos'] = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
      if (over?.id !== item.id || over.pos !== pos) setOver({ id: item.id, pos });
    },
    onDrop: (e) => {
      e.preventDefault();
      if (!dragId || !over) return;
      const at = open.findIndex((i) => i.id === over.id);
      const before = over.pos === 'before' ? over.id : (open[at + 1]?.id ?? null);
      if (before !== dragId) void props.onMove(dragId, before);
      setDragId(null);
      setOver(null);
      setArmedId(null);
    },
  });

  const draftRow = (after?: string) => (
    <TaskRow
      key={`draft:${after ?? 'top'}`}
      item={{ id: 'draft', title: '', body: '', done: false } as T}
      draft
      open={false}
      focus={null}
      onFocused={() => undefined}
      onOpen={() => setOpenId(null)}
      onClose={() => undefined}
      onTitle={async (title) => {
        await props.onCreate(title, after);
        closeDraft();
      }}
      onBody={async () => undefined}
      onEnter={async (title) => {
        const created = await props.onCreate(title, after);
        // Keep going: the next row opens under the one just written.
        if (created) {
          props.onAddingChange(false);
          setDraft({ after: created.id });
        } else closeDraft();
      }}
      onBackspaceEmpty={closeDraft}
      onCancel={closeDraft}
      onToggle={() => undefined}
      completing={false}
      onDelete={() => undefined}
      titlePlaceholder={props.titlePlaceholder}
      drag={null}
    />
  );

  const row = (item: T) => (
    <TaskRow
      key={item.id}
      item={item}
      open={openId === item.id}
      focus={focusReq?.id === item.id ? focusReq.field : null}
      onFocused={() => setFocusReq(null)}
      onOpen={() => setOpenId(item.id)}
      onClose={() => setOpenId((cur) => (cur === item.id ? null : cur))}
      onTitle={(title) => props.onUpdate(item.id, { title })}
      onBody={(body) => props.onUpdate(item.id, { body })}
      onEnter={async (title) => {
        if (title && title !== item.title) await props.onUpdate(item.id, { title });
        if (item.done) return;
        props.onAddingChange(false);
        setDraft({ after: item.id });
      }}
      onBackspaceEmpty={() => remove(item)}
      onCancel={() => undefined}
      onToggle={() => toggle(item)}
      completing={completing.has(item.id)}
      onDelete={() => remove(item)}
      meta={props.meta?.(item)}
      extra={props.extra?.(item)}
      actions={props.actions?.(item)}
      titlePlaceholder={props.titlePlaceholder}
      drag={item.done ? null : dragProps(item)}
    />
  );

  return (
    <div className={`task-list ${dragId ? 'dragging' : ''}`}>
      {draft && draft.after === undefined && (
        <>
          {draftRow()}
          {props.addHint && <div className="task-add-hint">{props.addHint}</div>}
        </>
      )}
      {open.map((item) => (
        <Fragment key={item.id}>
          {row(item)}
          {draft?.after === item.id && draftRow(item.id)}
        </Fragment>
      ))}
      {open.length === 0 && !draft && <div className="task-empty">{items.length > 0 ? props.allDoneText : props.emptyText}</div>}
      {done.length > 0 && (
        <div className="task-done">
          <div className="task-done-head">
            <button type="button" className="task-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              <span className={`chev ${showDone ? 'open' : ''}`}>▸</span>
              {props.doneLabel} ({done.length})
            </button>
            <span className="spacer" />
            {showDone && props.onClearDone && (
              <button type="button" className="link" onClick={() => void props.onClearDone?.()}>
                全部删除
              </button>
            )}
          </div>
          {showDone && done.map(row)}
        </div>
      )}
    </div>
  );
}
