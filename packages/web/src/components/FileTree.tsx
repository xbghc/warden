import { ActionIcon } from './ActionIcon';
import { useEffect, useMemo, useState } from 'react';
import { FileIcon } from '@react-symbols/icons/utils';
import type { FileEntry, TargetKey } from '@warden/shared';
import { formatTargetKey, targetLabel, stageModeFor, commentScopeKey, isLocalTarget, tryParseTargetKey } from '@warden/shared';
import { useStore } from '../store';
import { allDirPaths, buildTree, type DirNode, type TreeNode } from '../lib/tree';

const STATUS_LABEL: Record<FileEntry['status'], string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' };
export const STATUS_LETTER: Record<FileEntry['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

function FileStatusLabel({ status }: { status: FileEntry['status'] }) {
  return (
    <span className={`status status-${status}`} title={STATUS_LABEL[status]} role="img" aria-label={STATUS_LABEL[status]}>
      {STATUS_LETTER[status]}
    </span>
  );
}

function TreeIcon({ kind }: { kind: 'folder' | 'expand' | 'collapse' | 'check' }) {
  return (
    <svg
      className={`tree-icon tree-icon-${kind}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'folder' && <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />}
      {kind === 'expand' && <path d="m8 8 4-4 4 4M12 4v6m-4 6 4 4 4-4m-4-2v6" />}
      {kind === 'collapse' && <path d="m8 4 4 4 4-4M12 2v6m-4 12 4-4 4 4m-4-4v6" />}
      {kind === 'check' && <path d="m5 12 4 4L19 6" />}
    </svg>
  );
}

function FileRow({ node, depth, view }: { node: Extract<TreeNode, { kind: 'file' }>; depth: number; view: TargetKey }) {
  // A file staged halfway appears in both blocks; only the one in the view in front is highlighted.
  const active = useStore((s) => s.activeFile === node.path && s.targetKey === view);
  const inView = useStore((s) => s.targetKey === view);
  const openFile = useStore((s) => s.openFile);
  const switchView = useStore((s) => s.switchView);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const commentCount = useStore((s) => s.comments.filter((c) => c.filePath === node.path && c.targetKey === view).length);
  const stageLines = useStore((s) => s.stageLines);
  const staging = useStore((s) => s.staging);
  const target = tryParseTargetKey(view);
  const mode = target ? stageModeFor(target) : undefined;
  const e = node.entry;

  const open = async () => {
    if (!inView) await switchView(view, node.path);
    await openFile(node.path);
  };

  return (
    <div
      className={`tree-row file ${active ? 'active' : ''} ${e.viewed ? 'viewed' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      title={e.oldPath ? `${e.oldPath} → ${e.path}` : e.path}
    >
      <input
        type="checkbox"
        className="viewed-box"
        checked={e.viewed}
        onClick={(ev) => ev.stopPropagation()}
        onChange={() => void toggleViewed(node.path, view)}
        title="标记为已查看"
        aria-label={`标记 ${node.path} 为已查看`}
      />
      <button
        className="tree-file-open"
        onClick={() => void open()}
        aria-current={active ? 'true' : undefined}
        aria-label={`打开 ${node.path}`}
        title={`${node.path} · ${STATUS_LABEL[e.status]} · ${e.binary ? '二进制文件' : `+${e.additions} −${e.deletions}`}`}
      >
        <span className="tree-file-icon" aria-hidden="true">
          <FileIcon fileName={node.name} autoAssign />
        </span>
        <span className="name">{node.name}</span>
        {e.changed && <span className="tree-changed" title="文件自上次标记已查看后发生变化" aria-label="文件有新变化" />}
        {commentCount > 0 && (
          <span className="cc" title={`${commentCount} 条评论`}>
            {commentCount}
          </span>
        )}
        <FileStatusLabel status={e.status} />
        <span className="counts">
          {e.binary ? (
            <span className="tree-binary">BIN</span>
          ) : (
            <>
              <span className="add">+{e.additions}</span>
              <span className="del">-{e.deletions}</span>
            </>
          )}
        </span>
      </button>
      {mode && !e.binary && (
        <button
          className="link stage-file"
          disabled={staging}
          onClick={(event) => {
            event.stopPropagation();
            void stageLines(node.path, undefined, view);
          }}
        >
          <ActionIcon name={mode === 'stage' ? 'add' : 'back'} label={mode === 'stage' ? '暂存文件' : '取消暂存文件'} />
        </button>
      )}
    </div>
  );
}

function DirRow({ node, depth, view, open, toggle }: { node: DirNode; depth: number; view: TargetKey; open: Set<string>; toggle: (p: string) => void }) {
  const isOpen = open.has(node.path);
  return (
    <>
      <button className="tree-row dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(node.path)} aria-expanded={isOpen} title={node.path}>
        <span className={`chev ${isOpen ? 'open' : ''}`} aria-hidden="true">
          ›
        </span>
        <TreeIcon kind="folder" />
        <span className="name">{node.name}</span>
        <span className="muted count">{node.fileCount}</span>
      </button>
      {isOpen &&
        node.children.map((c) =>
          c.kind === 'dir' ? (
            <DirRow key={c.path} node={c} depth={depth + 1} view={view} open={open} toggle={toggle} />
          ) : (
            <FileRow key={c.path} node={c} depth={depth + 1} view={view} />
          ),
        )}
    </>
  );
}

function useTreeState(tree: DirNode, view: TargetKey) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const activeFile = useStore((s) => s.activeFile);
  const inView = useStore((s) => s.targetKey === view);

  // Reveal the active file after j/k navigation or a jump from a comment.
  useEffect(() => {
    if (!activeFile || !inView) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (const d of allDirPaths(tree)) if (activeFile.startsWith(d + '/')) next.add(d);
      return next.size === prev.size ? prev : next;
    });
  }, [activeFile, inView, tree]);

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return { open, setOpen, toggle };
}

function TreeBlock({ title, view, files, empty }: { title: string; view: TargetKey; files: FileEntry[]; empty: string }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const { open, setOpen, toggle } = useTreeState(tree, view);
  const directories = useMemo(() => allDirPaths(tree), [tree]);
  const hasExpandedDirectory = tree.children.some((node) => node.kind === 'dir' && open.has(node.path));
  const toggleLabel = hasExpandedDirectory ? '折叠全部目录' : '展开全部目录';
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const viewed = files.filter((f) => f.viewed).length;

  return (
    <section className="tree-block" aria-label={title}>
      <div className="block-head">
        <div className="block-heading">
          <span className={`block-indicator ${tryParseTargetKey(view)?.kind === 'staged' ? 'is-staged' : ''}`} aria-hidden="true" />
          <span className="block-title">{title}</span>
          <span className="block-file-count" aria-label={`${files.length} 个文件`}>
            {files.length}
          </span>
          <span className="spacer" />
          <span className="tree-tools">
            <button
              onClick={() => setOpen(new Set(hasExpandedDirectory ? [] : directories))}
              title={toggleLabel}
              aria-label={toggleLabel}
              disabled={directories.length === 0}
            >
              <TreeIcon kind={hasExpandedDirectory ? 'collapse' : 'expand'} />
            </button>
          </span>
        </div>
        {files.length > 0 && (
          <div className="block-summary">
            <span className="block-diff-counts">
              <span className="add">+{add}</span>
              <span className="del">−{del}</span>
            </span>
            <span
              className="block-progress"
              role="progressbar"
              aria-label={`${title} 查看进度`}
              aria-valuemin={0}
              aria-valuemax={files.length}
              aria-valuenow={viewed}
            >
              <span style={{ width: `${(viewed / files.length) * 100}%` }} />
            </span>
            <span className="block-reviewed" title={`已查看 ${viewed}/${files.length} 个文件`}>
              {viewed === files.length && <TreeIcon kind="check" />}
              {viewed}/{files.length}
            </span>
          </div>
        )}
      </div>
      <div className="tree">
        {files.length === 0 ? (
          <div className="tree-empty" role="status">
            <TreeIcon kind="folder" />
            <span>{empty}</span>
          </div>
        ) : (
          tree.children.map((c) =>
            c.kind === 'dir' ? (
              <DirRow key={c.path} node={c} depth={0} view={view} open={open} toggle={toggle} />
            ) : (
              <FileRow key={c.path} node={c} depth={0} view={view} />
            ),
          )
        )}
      </div>
    </section>
  );
}

function ReviewProgress({ done, total, label, hint }: { done: number; total: number; label: string; hint: string }) {
  const pct = total === 0 ? 0 : (done / total) * 100;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} title={hint}>
      <div className="progress-figure">
        <span className={`progress-done ${done === total && total > 0 ? 'complete' : ''}`}>{done}</span>
        <span className="progress-of">/ {total}</span>
        <span className="progress-label">{label}</span>
      </div>
      <div className="progress-track">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function FileTree() {
  const files = useStore((s) => s.files);
  const unstaged = useStore((s) => s.unstaged);
  const staged = useStore((s) => s.staged);
  const loading = useStore((s) => s.filesLoading);
  const error = useStore((s) => s.filesError);
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);

  const target = useMemo(() => tryParseTargetKey(targetKey), [targetKey]);
  const local = !!target && isLocalTarget(target);
  const worktree = target?.worktree ? { worktree: target.worktree } : {};
  // Remounts the blocks when the scope changes (another worktree), keeping the expanded
  // directories across a plain view switch — which is not supposed to reset anything.
  const scope = commentScopeKey(targetKey);

  // A commit, a range or a branch view is entered from the Commits panel, so the sidebar says which
  // one is up and holds the only way back to the working tree — even when the listing failed (a
  // bad ref, say). A worktree target that failed to list is the one case where the way back must
  // leave the worktree: it may itself be what is wrong (removed while the page was open), and every
  // other control on the page would carry it along. Otherwise the worktree is already named in the
  // top bar's selector, so the label leaves it out.
  const stranded = !!error && !!target?.worktree;
  const back = (!local || stranded) && (
    <div className="sidebar-target">
      <span className="sidebar-target-name" title={targetKey}>
        {!target ? targetKey : stranded ? targetLabel(target) : targetLabel({ ...target, worktree: undefined })}
      </span>
      <span className="spacer" />
      <button
        className="link"
        onClick={() => void setTarget(formatTargetKey(stranded ? { kind: 'working' } : { kind: 'working', ...worktree }))}
        title={stranded ? '回到主仓库的工作区' : '回到工作区的 Unstaged / Staged 视图'}
      >
        {stranded ? '← 回到主仓库' : '← 返回工作区'}
      </button>
    </div>
  );

  if (error) {
    return (
      <>
        {back}
        <div className="error-box">{error}</div>
      </>
    );
  }

  if (local) {
    // A file half staged sits in both blocks; it counts as read only once nothing of it is left
    // in the working tree, which is exactly what "staged means reviewed" says.
    const left = new Set(unstaged.map((f) => f.path));
    const total = new Set([...left, ...staged.map((f) => f.path)]).size;
    const done = staged.filter((f) => !left.has(f.path)).length;
    return (
      <>
        <ReviewProgress done={done} total={total} label="个文件已审" hint="暂存即视为已审：一个文件的改动全部进了暂存区，就算读完了" />
        <div className="tree-blocks">
          <TreeBlock
            key={`${scope}:unstaged`}
            title="未暂存"
            view={formatTargetKey({ kind: 'working', ...worktree })}
            files={unstaged}
            empty={loading ? '加载中…' : '没有未暂存的改动'}
          />
          <TreeBlock
            key={`${scope}:staged`}
            title="已暂存"
            view={formatTargetKey({ kind: 'staged', ...worktree })}
            files={staged}
            empty={loading ? '加载中…' : '空'}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {back}
      <ReviewProgress done={files.filter((f) => f.viewed).length} total={files.length} label="个文件已读" hint="勾选文件旁的框，或用文件头的“已读”标记" />
      <div className="tree-blocks">
        <TreeBlock key={scope} title="改动" view={targetKey} files={files} empty={loading ? '加载中…' : '没有改动'} />
      </div>
    </>
  );
}
