import { Button } from './ui/button';
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon } from './ActionIcon';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DiffSide, DiffLine, FileDiff } from '@warden/shared';
import { useStore } from '../store';
import { api } from '../api';
import { type Block, buildRows, findRowIndex, hunkRowIndices, type Expansion, type Gap, type Row } from '../lib/rows';
import { langForPath, tokenizeLines, type Token } from '../lib/highlight';

const EXPAND_STEP = 20;

/**
 * Top visible line per file, so a refresh that re-renders the diff can put the reader back where
 * they were. Module scope on purpose: DiffView is remounted whenever the diff content changes.
 */
const scrollMemory = new Map<string, { side: DiffSide; line: number }>();

/** The line a row shows, preferring the new side in split view. */
function rowAnchor(row: Row): { side: DiffSide; line: number } | undefined {
  const from = (line: DiffLine, side: DiffSide) => {
    const no = side === 'old' ? line.oldLineNo : line.newLineNo;
    return no === undefined ? undefined : { side, line: no };
  };
  if (row.kind === 'line') return from(row.line, row.line.type === 'del' ? 'old' : 'new');
  if (row.kind === 'pair') return (row.right && from(row.right, 'new')) ?? (row.left && from(row.left, 'old'));
  return undefined;
}

function tokenKey(line: DiffLine, side: DiffSide): string {
  if (line.type === 'context' || side === 'new') return `new:${line.newLineNo ?? line.oldLineNo}`;
  return `old:${line.oldLineNo}`;
}

function CodeLine({ content, tokens }: { content: string; tokens: Token[] | undefined }) {
  if (!tokens) return <span className="code-text">{content || '​'}</span>;
  return (
    <span className="code-text">
      {tokens.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a token has no identity of its own; the line re-renders whole
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
      {content === '' && '​'}
    </span>
  );
}

const GUTTER_TITLE = '点击：复制 文件:行号\nShift+点击：复制从上次复制的行到这一行的范围';

function estimateRow(row: Row): number {
  switch (row.kind) {
    case 'hunk':
    case 'gap':
    case 'debug':
      return 26;
    default:
      return 22;
  }
}

export function DiffView({ diff }: { diff: FileDiff }) {
  const viewMode = useStore((s) => s.prefs.viewMode);
  const foldDebug = useStore((s) => s.prefs.ignoreDebug);
  const targetKey = useStore((s) => s.targetKey);
  const copyToClipboard = useStore((s) => s.copyToClipboard);
  const showToast = useStore((s) => s.showToast);
  const [expansions, setExpansions] = useState<Record<number, Expansion>>({});
  const [openDebug, setOpenDebug] = useState<ReadonlySet<string>>(() => new Set());
  const toggleDebug = (id: string) =>
    setOpenDebug((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [shutBlocks, setShutBlocks] = useState<ReadonlySet<string>>(() => new Set());
  const toggleBlock = (id: string) =>
    setShutBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [fullLines, setFullLines] = useState<string[] | null>(null);
  const fullLoading = useRef<Promise<string[] | null> | null>(null);
  const rows = useMemo(
    () => buildRows({ diff, viewMode, expansions, fullLines, foldDebug, openDebug, shutBlocks }),
    [diff, viewMode, expansions, fullLines, foldDebug, openDebug, shutBlocks],
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

  // ---- scroll position across refreshes ------------------------------------
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let frame = 0;
    const remember = () => {
      frame = 0;
      const first = virtualizer.getVirtualItems()[0];
      const anchor = first ? rowAnchor(rows[first.index]!) : undefined;
      if (anchor) scrollMemory.set(diff.path, anchor);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(remember);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rows, virtualizer, diff.path]);

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (!useStore.getState().consumeRestoreScroll()) return;
    const mem = scrollMemory.get(diff.path);
    if (!mem) return;
    const idx = findRowIndex(rows, mem.side, mem.line);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- hunk navigation (n / p) -------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useStore.getState().panel !== 'diff') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        ((t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      )
        return;
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
  /** The last copied line is the start of a subsequent Shift-click range. */
  const copyAnchor = useRef<{ side: DiffSide; line: number } | null>(null);

  /** Copy a review location; Shift extends the last copied range on the same side. */
  const gutterClick = (e: ReactMouseEvent, line: DiffLine, column: DiffSide) => {
    const side: DiffSide = column === 'old' ? (line.oldLineNo !== undefined ? 'old' : 'new') : line.newLineNo !== undefined ? 'new' : 'old';
    const no = side === 'old' ? line.oldLineNo : line.newLineNo;
    if (no === undefined) return;
    const anchor = copyAnchor.current;
    const range = e.shiftKey && anchor?.side === side ? [Math.min(anchor.line, no), Math.max(anchor.line, no)] : [no, no];
    if (!(e.shiftKey && anchor?.side === side)) copyAnchor.current = { side, line: no };
    const lines = range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
    void copyToClipboard(`${diff.path}:${lines}${side === 'old' ? '（修改前）' : ''}`);
  };

  const renderGap = (row: Extract<Row, { kind: 'gap' }>) => {
    const { gap, hidden } = row;
    const isFirst = gap.index === 0;
    const isLast = gap.index === diff.hunks.length;
    return (
      <div className="row gap-row">
        {!isFirst && (
          <Button variant="ghost" size="icon-sm" className="link" onClick={() => void expand(gap, 'top')} title="展开紧接上一个 hunk 之后的 20 行">
            <ActionIcon name="up" label={`展开上方 ${EXPAND_STEP} 行`} />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" className="link" onClick={() => void expand(gap, 'all')}>
          <ActionIcon name="expand" label={`展开全部${hidden !== null ? ` (${hidden} 行)` : ''}`} count={hidden ?? undefined} />
        </Button>
        {!isLast && (
          <Button variant="ghost" size="icon-sm" className="link" onClick={() => void expand(gap, 'bottom')} title="展开紧接下一个 hunk 之前的 20 行">
            <ActionIcon name="down" label={`展开下方 ${EXPAND_STEP} 行`} />
          </Button>
        )}
      </div>
    );
  };

  // ---- code blocks -----------------------------------------------------------------
  const renderFoldToggle = (block: Block | undefined) => (
    <span className="foldc">
      {block && (
        <Button
          variant="outline"
          size="sm"
          className={`fold-btn ${block.open ? '' : 'shut'}`}
          onClick={() => toggleBlock(block.id)}
          aria-expanded={block.open}
          title={block.open ? `折叠这段代码（${block.lines.length} 行）` : '展开这段代码'}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
      )}
    </span>
  );
  // Summarize the changed lines inside a collapsed block.
  const renderFoldChip = (block: Block | undefined) =>
    block && !block.open ? (
      <Button variant="ghost" size="sm" className="fold-chip" onClick={() => toggleBlock(block.id)} title="展开这段代码">
        ⋯ {block.lines.length} 行
        {(block.adds > 0 || block.dels > 0) && (
          <>
            {block.adds > 0 && <span className="add"> +{block.adds}</span>}
            {block.dels > 0 && <span className="del"> −{block.dels}</span>}
          </>
        )}
      </Button>
    ) : null;

  const renderUnified = (row: Extract<Row, { kind: 'line' }>) => {
    const l = row.line;
    const side: DiffSide = l.type === 'del' ? 'old' : 'new';
    const tokens = tokenCache.current.get(tokenKey(l, side));
    return (
      <div className={`row line ${l.type} ${row.expanded ? 'expanded' : ''}`}>
        <span className="gut" onClick={(e) => gutterClick(e, l, 'old')} title={GUTTER_TITLE}>
          {l.oldLineNo ?? ''}
        </span>
        <span className="gut" onClick={(e) => gutterClick(e, l, 'new')} title={GUTTER_TITLE}>
          {l.newLineNo ?? ''}
        </span>
        {renderFoldToggle(row.block)}
        <span className="marker">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
        <span className="code">
          <CodeLine content={l.content} tokens={tokens} />
          {l.noNewline && (
            <span className="nonl" title="No newline at end of file">
              ⏎
            </span>
          )}
          {renderFoldChip(row.block)}
        </span>
      </div>
    );
  };

  const renderSplitCell = (row: Extract<Row, { kind: 'pair' }>, l: DiffLine | undefined, side: DiffSide) => {
    if (!l) return <span className="cell blank" />;
    const no = side === 'old' ? l.oldLineNo : l.newLineNo;
    const type = l.type === 'context' ? 'context' : side === 'old' ? 'del' : 'add';
    const tokens = tokenCache.current.get(tokenKey(l, side));
    // The block is read off the new side, so its toggle sits there — on the old side only when a
    // deletion has nothing across from it.
    const block = (side === 'new') === !!row.right ? row.block : undefined;
    return (
      <span className={`cell ${type}`}>
        <span className="gut" onClick={(e) => gutterClick(e, l, side)} title={GUTTER_TITLE}>
          {no ?? ''}
        </span>
        {renderFoldToggle(block)}
        <span className="code">
          <CodeLine content={l.content} tokens={tokens} />
          {renderFoldChip(block)}
        </span>
      </span>
    );
  };

  const renderDebug = (row: Extract<Row, { kind: 'debug' }>) => {
    const changed = row.lines.filter((l) => l.type !== 'context').length;
    const what = changed === row.lines.length ? `${changed} 行调试代码改动` : `${row.lines.length} 行调试代码（${changed} 行改动）`;
    return (
      <div className={`row debug-row ${row.open ? 'open' : ''}`}>
        <Button
          variant="ghost"
          size="sm"
          className="link"
          onClick={() => toggleDebug(row.id)}
          aria-expanded={row.open}
          title="调试块或标了 nocommit 的行；折叠仅影响显示"
        >
          {row.open ? `收起 ${what}` : `已折叠 ${what}`}
        </Button>
      </div>
    );
  };

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case 'gap':
        return renderGap(row);
      case 'debug':
        return renderDebug(row);
      case 'hunk':
        return (
          <div className="row hunk-head">
            <span className="hunk-text">
              @@ -{row.hunk.oldStart},{row.hunk.oldLines} +{row.hunk.newStart},{row.hunk.newLines} @@ <span className="muted">{row.hunk.header}</span>
            </span>
          </div>
        );
      case 'line':
        return renderUnified(row);
      case 'pair': {
        return (
          <div className={`row pair ${row.expanded ? 'expanded' : ''}`}>
            {renderSplitCell(row, row.left, 'old')}
            {renderSplitCell(row, row.right, 'new')}
          </div>
        );
      }
    }
  };

  const items = virtualizer.getVirtualItems();
  return (
    <div ref={parentRef} className="diff-scroll">
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
