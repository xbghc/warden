import { useEffect, useMemo, useState } from 'react';
import type { FileEntry } from '@warden/shared';
import { useStore } from '../store';
import { allDirPaths, buildTree, type DirNode, type TreeNode } from '../lib/tree';

const STATUS_LETTER: Record<FileEntry['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

function FileRow({ node, depth }: { node: Extract<TreeNode, { kind: 'file' }>; depth: number }) {
  const active = useStore((s) => s.activeFile === node.path);
  const openFile = useStore((s) => s.openFile);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const commentCount = useStore((s) => s.comments.filter((c) => c.filePath === node.path).length);
  const e = node.entry;
  return (
    <div
      className={`tree-row file ${active ? 'active' : ''} ${e.viewed ? 'viewed' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => void openFile(node.path)}
      title={e.oldPath ? `${e.oldPath} → ${e.path}` : e.path}
    >
      <input
        type="checkbox"
        className="viewed-box"
        checked={e.viewed}
        onClick={(ev) => ev.stopPropagation()}
        onChange={() => void toggleViewed(node.path)}
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

function DirRow({ node, depth, open, toggle }: { node: DirNode; depth: number; open: Set<string>; toggle: (p: string) => void }) {
  const isOpen = open.has(node.path);
  return (
    <>
      <div className="tree-row dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(node.path)}>
        <span className={`chev ${isOpen ? 'open' : ''}`}>▸</span>
        <span className="name">{node.name}</span>
        <span className="muted count">{node.fileCount}</span>
      </div>
      {isOpen && node.children.map((c) => (c.kind === 'dir' ? <DirRow key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} /> : <FileRow key={c.path} node={c} depth={depth + 1} />))}
    </>
  );
}

export function FileTree() {
  const files = useStore((s) => s.files);
  const loading = useStore((s) => s.filesLoading);
  const error = useStore((s) => s.filesError);
  const targetKey = useStore((s) => s.targetKey);
  const activeFile = useStore((s) => s.activeFile);
  const tree = useMemo(() => buildTree(files), [files]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Collapse everything when the target changes.
  useEffect(() => {
    setOpen(new Set());
  }, [targetKey]);

  // Make sure the active file's ancestors are open (e.g. after j/k navigation or an issue jump).
  useEffect(() => {
    if (!activeFile) return;
    setOpen((prev) => {
      const next = new Set(prev);
      const dirs = allDirPaths(tree);
      for (const d of dirs) if (activeFile.startsWith(d + '/')) next.add(d);
      return next.size === prev.size ? prev : next;
    });
  }, [activeFile, tree]);

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const viewed = files.filter((f) => f.viewed).length;
  const totalAdd = files.reduce((n, f) => n + f.additions, 0);
  const totalDel = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>
          {files.length} 个文件 <span className="add">+{totalAdd}</span> <span className="del">-{totalDel}</span>
        </span>
        <span className="muted">{viewed}/{files.length} viewed</span>
        <span className="tree-tools">
          <button className="link" onClick={() => setOpen(new Set(allDirPaths(tree)))}>
            展开
          </button>
          <button className="link" onClick={() => setOpen(new Set())}>
            折叠
          </button>
        </span>
      </div>
      <div className="tree">
        {error && <div className="error-box">{error}</div>}
        {!error && !loading && files.length === 0 && <div className="muted empty">没有改动</div>}
        {loading && files.length === 0 && <div className="muted empty">加载中…</div>}
        {tree.children.map((c) => (c.kind === 'dir' ? <DirRow key={c.path} node={c} depth={0} open={open} toggle={toggle} /> : <FileRow key={c.path} node={c} depth={0} />))}
      </div>
    </aside>
  );
}
