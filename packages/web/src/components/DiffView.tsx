import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CommentSide, DiffLine, FileDiff, Hunk } from '@warden/shared';
import { useStore } from '../store';
import { api } from '../api';
import { buildRows, findRowIndex, hunkRowIndices, type EditorState, type Expansion, type Gap, type Row } from '../lib/rows';
import { langForPath, tokenizeLines, type Token } from '../lib/highlight';
import { CommentThread } from './CommentThread';
import { CommentEditor } from './CommentEditor';

interface Selection {
  side: CommentSide;
  hunkIndex: number;
  anchor: number;
  head: number;
}

const EXPAND_STEP = 20;

function tokenKey(line: DiffLine, side: CommentSide): string {
  if (line.type === 'context' || side === 'new') return `new:${line.newLineNo ?? line.oldLineNo}`;
  return `old:${line.oldLineNo}`;
}

function CodeLine({ content, tokens }: { content: string; tokens: Token[] | undefined }) {
  if (!tokens) return <span className="code-text">{content || '​'}</span>;
  return (
    <span className="code-text">
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
      {content === '' && '​'}
    </span>
  );
}

/** Line to jump to in nvim for a diff line (nearest new-side line for deleted lines). */
function nvimLine(line: DiffLine, hunk: Hunk | undefined): number {
  if (line.newLineNo !== undefined) return line.newLineNo;
  if (!hunk) return line.oldLineNo ?? 1;
  const idx = hunk.lines.indexOf(line);
  for (let i = idx + 1; i < hunk.lines.length; i++) {
    const n = hunk.lines[i]!.newLineNo;
    if (n !== undefined) return n;
  }
  for (let i = idx - 1; i >= 0; i--) {
    const n = hunk.lines[i]!.newLineNo;
    if (n !== undefined) return n;
  }
  return hunk.newStart;
}

function estimateRow(row: Row): number {
  switch (row.kind) {
    case 'comments':
      return 90 * row.comments.length;
    case 'editor':
      return 170;
    case 'hunk':
    case 'gap':
      return 26;
    default:
      return 22;
  }
}

export function DiffView({ diff }: { diff: FileDiff }) {
  const viewMode = useStore((s) => s.prefs.viewMode);
  const targetKey = useStore((s) => s.targetKey);
  const allComments = useStore((s) => s.comments);
  const comments = useMemo(() => allComments.filter((c) => c.filePath === diff.path), [allComments, diff.path]);
  const createComment = useStore((s) => s.createComment);
  const updateComment = useStore((s) => s.updateComment);
  const openInNvim = useStore((s) => s.openInNvim);
  const showToast = useStore((s) => s.showToast);
  const reattaching = useStore((s) => s.reattaching);
  const jumpTo = useStore((s) => s.jumpTo);

  const [expansions, setExpansions] = useState<Record<number, Expansion>>({});
  const [fullLines, setFullLines] = useState<string[] | null>(null);
  const fullLoading = useRef<Promise<string[] | null> | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [sel, setSelState] = useState<Selection | null>(null);
  const selRef = useRef<Selection | null>(null);
  const setSel = useCallback((s: Selection | null) => {
    selRef.current = s;
    setSelState(s);
  }, []);
  const [flash, setFlash] = useState<{ side: CommentSide; line: number } | null>(null);

  const rows = useMemo(
    () => buildRows({ diff, viewMode, comments, editor, expansions, fullLines }),
    [diff, viewMode, comments, editor, expansions, fullLines],
  );

  // ---- syntax highlighting -------------------------------------------------
  const lang = useMemo(() => langForPath(diff.path), [diff.path]);
  const tokenCache = useRef(new Map<string, Token[]>());
  const [, bumpTokens] = useState(0);
  useEffect(() => {
    if (!lang) return;
    const cache = tokenCache.current;
    const groups = new Map<string, { keys: string[]; lines: string[] }>();
    const add = (group: string, key: string, content: string) => {
      if (cache.has(key)) return;
      let g = groups.get(group);
      if (!g) {
        g = { keys: [], lines: [] };
        groups.set(group, g);
      }
      if (g.keys.includes(key)) return;
      g.keys.push(key);
      g.lines.push(content);
    };
    const visit = (l: DiffLine, hunkIndex: number) => {
      if (l.type === 'del') add(`${hunkIndex}:old`, tokenKey(l, 'old'), l.content);
      else add(`${hunkIndex}:new`, tokenKey(l, 'new'), l.content);
    };
    for (const r of rows) {
      if (r.kind === 'line') visit(r.line, r.hunkIndex);
      else if (r.kind === 'pair') {
        if (r.left) visit(r.left, r.hunkIndex);
        if (r.right && r.right !== r.left) visit(r.right, r.hunkIndex);
      }
    }
    if (groups.size === 0) return;
    let cancelled = false;
    (async () => {
      let changed = false;
      for (const g of groups.values()) {
        const toks = await tokenizeLines(lang, g.lines);
        if (cancelled) return;
        if (!toks) return;
        g.keys.forEach((k, i) => {
          const t = toks[i];
          if (t) cache.set(k, t);
        });
        changed = true;
      }
      if (changed) bumpTokens((v) => v + 1);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rows, lang]);

  // ---- virtualization --------------------------------------------------------
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => estimateRow(rows[i]!),
    overscan: 12,
    getItemKey: (i) => rows[i]!.key,
  });

  // ---- jump to a line (issue / comment navigation) -------------------------
  useEffect(() => {
    if (!jumpTo || jumpTo.file !== diff.path) return;
    const idx = findRowIndex(rows, jumpTo.side, jumpTo.line);
    if (idx < 0) return;
    virtualizer.scrollToIndex(idx, { align: 'center' });
    setFlash({ side: jumpTo.side, line: jumpTo.line });
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  // ---- hunk navigation (n / p) -------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && ((t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key !== 'n' && e.key !== 'p') return;
      const hunks = hunkRowIndices(rows);
      if (!hunks.length) return;
      const el = parentRef.current;
      const top = el ? el.scrollTop : 0;
      const positions = hunks.map((i) => virtualizer.getOffsetForIndex(i, 'start')?.[0] ?? 0);
      let next: number | undefined;
      if (e.key === 'n') next = hunks.find((_, k) => positions[k]! > top + 4);
      else {
        for (let k = hunks.length - 1; k >= 0; k--) {
          if (positions[k]! < top - 4) {
            next = hunks[k];
            break;
          }
        }
      }
      if (next === undefined) return;
      e.preventDefault();
      virtualizer.scrollToIndex(next, { align: 'start' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, virtualizer]);

  // ---- selection ---------------------------------------------------------------
  useEffect(() => {
    const up = () => {
      const s = selRef.current;
      if (!s) return;
      setSel(null);
      const startLine = Math.min(s.anchor, s.head);
      const endLine = Math.max(s.anchor, s.head);
      const re = useStore.getState().reattaching;
      if (re) {
        void updateComment(re, { side: s.side, startLine, endLine });
      } else {
        setEditor({ side: s.side, startLine, endLine });
      }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [setSel, updateComment]);

  const startSel = (e: React.MouseEvent, side: CommentSide, hunkIndex: number, line: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSel({ side, hunkIndex, anchor: line, head: line });
  };
  const extendSel = (side: CommentSide, hunkIndex: number, line: number) => {
    const s = selRef.current;
    if (!s || s.side !== side || s.hunkIndex !== hunkIndex || s.head === line) return;
    setSel({ ...s, head: line });
  };
  const isSelected = (side: CommentSide, line: number | undefined): boolean => {
    if (!sel || line === undefined || sel.side !== side) return false;
    return line >= Math.min(sel.anchor, sel.head) && line <= Math.max(sel.anchor, sel.head);
  };
  const isFlash = (side: CommentSide, line: number | undefined) => !!flash && flash.side === side && flash.line === line;

  // ---- context expansion -------------------------------------------------------
  const ensureFull = useCallback(async (): Promise<string[] | null> => {
    if (fullLines) return fullLines;
    if (!fullLoading.current) {
      fullLoading.current = api
        .fullFile(targetKey, diff.path, 'new')
        .then((r) => {
          if (r.content === null) return null;
          const lines = r.content.split('\n');
          if (lines.length && lines[lines.length - 1] === '') lines.pop();
          setFullLines(lines);
          return lines;
        })
        .catch((e) => {
          showToast(e instanceof Error ? e.message : String(e), 'error');
          return null;
        })
        .finally(() => {
          fullLoading.current = null;
        });
    }
    return fullLoading.current;
  }, [fullLines, targetKey, diff.path, showToast]);

  const expand = async (gap: Gap, where: 'top' | 'bottom' | 'all') => {
    const lines = await ensureFull();
    if (!lines) {
      showToast('无法读取完整文件内容', 'error');
      return;
    }
    setExpansions((prev) => {
      const cur = prev[gap.index] ?? { top: 0, bottom: 0, all: false };
      const next: Expansion =
        where === 'all' ? { ...cur, all: true } : where === 'top' ? { ...cur, top: cur.top + EXPAND_STEP } : { ...cur, bottom: cur.bottom + EXPAND_STEP };
      return { ...prev, [gap.index]: next };
    });
  };

  // ---- rendering -----------------------------------------------------------------
  const gutterClick = (line: DiffLine, hunkIndex: number) => {
    const hunk = diff.hunks[hunkIndex];
    void openInNvim(diff.path, nvimLine(line, hunk));
  };

  const renderGap = (row: Extract<Row, { kind: 'gap' }>) => {
    const { gap, hidden } = row;
    const isFirst = gap.index === 0;
    const isLast = gap.index === diff.hunks.length;
    return (
      <div className="row gap-row">
        {!isFirst && (
          <button className="link" onClick={() => void expand(gap, 'top')} title="展开紧接上一个 hunk 之后的 20 行">
            ↑ 展开上方 {EXPAND_STEP} 行
          </button>
        )}
        <button className="link" onClick={() => void expand(gap, 'all')}>
          展开全部{hidden !== null ? ` (${hidden} 行)` : ''}
        </button>
        {!isLast && (
          <button className="link" onClick={() => void expand(gap, 'bottom')} title="展开紧接下一个 hunk 之前的 20 行">
            ↓ 展开下方 {EXPAND_STEP} 行
          </button>
        )}
      </div>
    );
  };

  const renderUnified = (row: Extract<Row, { kind: 'line' }>) => {
    const l = row.line;
    const side: CommentSide = l.type === 'del' ? 'old' : 'new';
    const no = side === 'old' ? l.oldLineNo : l.newLineNo;
    const selected = isSelected(side, no);
    const tokens = tokenCache.current.get(tokenKey(l, side));
    return (
      <div
        className={`row line ${l.type} ${selected ? 'selected' : ''} ${isFlash(side, no) ? 'flash' : ''} ${row.expanded ? 'expanded' : ''}`}
        onMouseEnter={() => no !== undefined && extendSel(side, row.hunkIndex, no)}
      >
        <span className="gut" onClick={() => gutterClick(l, row.hunkIndex)} title="在 nvim 中打开此行">
          {l.oldLineNo ?? ''}
        </span>
        <span className="gut" onClick={() => gutterClick(l, row.hunkIndex)} title="在 nvim 中打开此行">
          {l.newLineNo ?? ''}
        </span>
        <span className="addc">
          {!row.expanded && no !== undefined && (
            <button className="add-btn" onMouseDown={(e) => startSel(e, side, row.hunkIndex, no)} title="添加评论（可拖选多行）">
              +
            </button>
          )}
        </span>
        <span className="marker">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
        <span className="code">
          <CodeLine content={l.content} tokens={tokens} />
          {l.noNewline && <span className="nonl" title="No newline at end of file">⏎</span>}
        </span>
      </div>
    );
  };

  const renderSplitCell = (l: DiffLine | undefined, side: CommentSide, hunkIndex: number, expanded: boolean) => {
    if (!l) return <span className="cell empty" />;
    const no = side === 'old' ? l.oldLineNo : l.newLineNo;
    const type = l.type === 'context' ? 'context' : side === 'old' ? 'del' : 'add';
    const selected = isSelected(side, no);
    const tokens = tokenCache.current.get(tokenKey(l, side));
    return (
      <span className={`cell ${type} ${selected ? 'selected' : ''} ${isFlash(side, no) ? 'flash' : ''}`} onMouseEnter={() => no !== undefined && extendSel(side, hunkIndex, no)}>
        <span className="gut" onClick={() => gutterClick(l, hunkIndex)} title="在 nvim 中打开此行">
          {no ?? ''}
        </span>
        <span className="addc">
          {!expanded && no !== undefined && (
            <button className="add-btn" onMouseDown={(e) => startSel(e, side, hunkIndex, no)} title="添加评论（可拖选多行）">
              +
            </button>
          )}
        </span>
        <span className="code">
          <CodeLine content={l.content} tokens={tokens} />
        </span>
      </span>
    );
  };

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case 'gap':
        return renderGap(row);
      case 'hunk':
        return (
          <div className="row hunk-head">
            @@ -{row.hunk.oldStart},{row.hunk.oldLines} +{row.hunk.newStart},{row.hunk.newLines} @@ <span className="muted">{row.hunk.header}</span>
          </div>
        );
      case 'line':
        return renderUnified(row);
      case 'pair':
        return (
          <div className={`row pair ${row.expanded ? 'expanded' : ''}`}>
            {renderSplitCell(row.left, 'old', row.hunkIndex, row.expanded)}
            {renderSplitCell(row.right, 'new', row.hunkIndex, row.expanded)}
          </div>
        );
      case 'comments':
        return (
          <div className="row attach">
            <CommentThread comments={row.comments} />
          </div>
        );
      case 'editor':
        return (
          <div className="row attach">
            <CommentEditor
              title={`评论 ${diff.path}:${row.startLine === row.endLine ? row.startLine : `${row.startLine}-${row.endLine}`} (${row.side})`}
              onSave={async (body) => {
                const c = await createComment({ filePath: diff.path, side: row.side, startLine: row.startLine, endLine: row.endLine, body });
                if (c) setEditor(null);
              }}
              onCancel={() => setEditor(null)}
            />
          </div>
        );
    }
  };

  const items = virtualizer.getVirtualItems();
  return (
    <div ref={parentRef} className={`diff-scroll ${sel ? 'selecting' : ''} ${reattaching ? 'reattaching' : ''}`}>
      <div className={`diff-list ${viewMode}`} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="vrow"
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
          >
            {renderRow(rows[vi.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}
