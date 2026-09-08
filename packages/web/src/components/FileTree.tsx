import { useEffect, useMemo, useState } from 'react';
import type { FileEntry, TargetKey } from '@warden/shared';
import { commentScopeKey, formatTargetKey, isLocalTarget, targetLabel, tryParseTargetKey } from '@warden/shared';
import { useStore } from '../store';
import { allDirPaths, buildTree, type DirNode, type TreeNode } from '../lib/tree';

export const STATUS_LETTER: Record<FileEntry['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

function FileRow({ node, depth, view }: { node: Extract<TreeNode, { kind: 'file' }>; depth: number; view: TargetKey }) {
  // A file staged halfway appears in both blocks; only the one in the view in front is highlighted.
  const active = useStore((s) => s.activeFile === node.path && s.targetKey === view);
  const inView = useStore((s) => s.targetKey === view);
  const openFile = useStore((s) => s.openFile);
  const switchView = useStore((s) => s.switchView);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const commentCount = useStore((s) => s.comments.filter((c) => c.filePath === node.path && c.targetKey === view).length);
  const e = node.entry;

  const open = async () => {
    if (!inView) await switchView(view, node.path);
    await openFile(node.path);
  };

  return (
    <div
      className={`tree-row file ${active ? 'active' : ''} ${e.viewed ? 'viewed' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => void open()}
      title={e.oldPath ? `${e.oldPath} → ${e.path}` : e.path}
    >
      <input
        type="checkbox"
        className="viewed-box"
        checked={e.viewed}
        onClick={(ev) => ev.stopPropagation()}
        onChange={() => void toggleViewed(node.path, view)}
        title="标记为已查看"
      />
      <span className={`status status-${e.status}`}>{STATUS_LETTER[e.status]}</span>
      <span className="name">{node.name}</span>
      {e.changed && <span className="changed" title="文件自上次标记已查看后发生变化">已变化</span>}
      {commentCount > 0 && <span className="cc" title="评论数">{commentCount}</span>}
      <span className="counts">
        {e.binary ? (
          <span className="muted">bin</span>
        ) : (
          <>
            <span className="add">+{e.additions}</span>
            <span className="del">-{e.deletions}</span>
          </>
        )}
      </span>
    </div>
  );
}

function DirRow({ node, depth, view, open, toggle }: { node: DirNode; depth: number; view: TargetKey; open: Set<string>; toggle: (p: string) => void }) {
  const isOpen = open.has(node.path);
  return (
    <>
      <div className="tree-row dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(node.path)}>
        <span className={`chev ${isOpen ? 'open' : ''}`}>▸</span>
        <span className="name">{node.name}</span>
        <span className="muted count">{node.fileCount}</span>
      </div>
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
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const viewed = files.filter((f) => f.viewed).length;

  return (
    <section className="tree-block">
      <div className="block-head">
        <span className="block-title">{title}</span>
        <span className="block-n">{files.length}</span>
        <span className="counts">
          <span className="add">+{add}</span>
          <span className="del">-{del}</span>
        </span>
        <span className="spacer" />
        {files.length > 0 && (
          <span className="block-viewed" title="已标记为 viewed 的文件">
            {viewed}/{files.length} viewed
          </span>
        )}
        <span className="tree-tools">
          <button className="link" onClick={() => setOpen(new Set(allDirPaths(tree)))} title="展开全部目录">
            展开
          </button>
          <button className="link" onClick={() => setOpen(new Set())} title="折叠全部目录">
            折叠
          </button>
        </span>
      </div>
      {files.length > 0 && (
        <div className="block-progress" role="progressbar" aria-label={`${title} 已查看`} aria-valuemin={0} aria-valuemax={files.length} aria-valuenow={viewed}>
          <span style={{ width: `${(viewed / files.length) * 100}%` }} />
        </div>
      )}
      <div className="tree">
        {files.length === 0 ? (
          <div className="muted empty">{empty}</div>
        ) : (
          tree.children.map((c) =>
            c.kind === 'dir' ? <DirRow key={c.path} node={c} depth={0} view={view} open={open} toggle={toggle} /> : <FileRow key={c.path} node={c} depth={0} view={view} />,
          )
        )}
      </div>
    </section>
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
      <aside className="sidebar">
        {back}
        <div className="error-box">{error}</div>
      </aside>
    );
  }

  if (local) {
    return (
      <aside className="sidebar dual">
        <TreeBlock
          key={`${scope}:unstaged`}
          title="Unstaged"
          view={formatTargetKey({ kind: 'working', ...worktree })}
          files={unstaged}
          empty={loading ? '加载中…' : '没有未暂存的改动'}
        />
        <TreeBlock
          key={`${scope}:staged`}
          title="Staged"
          view={formatTargetKey({ kind: 'staged', ...worktree })}
          files={staged}
          empty={loading ? '加载中…' : '暂存区为空'}
        />
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      {back}
      <TreeBlock key={scope} title="改动" view={targetKey} files={files} empty={loading ? '加载中…' : '没有改动'} />
    </aside>
  );
}
