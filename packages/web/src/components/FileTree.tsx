import { Checkbox } from './ui/checkbox';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { useEffect, useMemo, useState } from 'react';
import { FileIcon } from '@react-symbols/icons/utils';
import type { Checkpoint, FileEntry, Target, TargetKey } from '@warden/shared';
import { formatTargetKey, targetLabel, commentScopeKey, tryParseTargetKey } from '@warden/shared';
import { useStore } from '../store';
import { allDirPaths, buildTree, type DirNode, type TreeNode } from '../lib/tree';

const STATUS_LABEL: Record<FileEntry['status'], string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' };
export const STATUS_LETTER: Record<FileEntry['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

function FileStatusLabel({ status, conflicted }: { status: FileEntry['status']; conflicted?: boolean }) {
  if (conflicted) {
    return (
      <span className="status status-conflicted" title="合并冲突：在终端里解决并 git add" role="img" aria-label="合并冲突">
        U
      </span>
    );
  }
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

interface RowProps {
  depth: number;
  view: TargetKey;
}

function FileRow({ node, depth, view }: RowProps & { node: Extract<TreeNode, { kind: 'file' }> }) {
  const active = useStore((s) => s.panel === 'diff' && s.activeFile === node.path && s.targetKey === view);
  const openFile = useStore((s) => s.openFile);
  const toggleViewed = useStore((s) => s.toggleViewed);
  const commentCount = useStore((s) => s.comments.filter((c) => c.filePath === node.path && c.targetKey === view).length);
  const e = node.entry;

  return (
    <div
      className={`tree-row file ${active ? 'active' : ''} ${e.viewed ? 'viewed' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      title={e.oldPath ? `${e.oldPath} → ${e.path}` : e.path}
    >
      <Checkbox
        className="viewed-box"
        checked={e.viewed}
        onClick={(ev) => ev.stopPropagation()}
        onCheckedChange={() => void toggleViewed(node.path)}
        title="标记为已读"
        aria-label={`标记 ${node.path} 为已读`}
      />
      <Button
        variant="ghost"
        size="sm"
        className="tree-file-open"
        onClick={() => void openFile(node.path)}
        aria-current={active ? 'true' : undefined}
        aria-label={`打开 ${node.path}`}
        title={`${node.path} · ${STATUS_LABEL[e.status]} · ${e.binary ? '二进制文件' : `+${e.additions} −${e.deletions}`}`}
      >
        <span className="tree-file-icon" aria-hidden="true">
          <FileIcon fileName={node.name} autoAssign />
        </span>
        <span className="name">{node.name}</span>
        {e.changed && <span className="tree-changed" title="文件自上次标记已读后发生变化" aria-label="文件有新变化" />}
        {commentCount > 0 && (
          <span className="cc" title={`${commentCount} 条评论`}>
            {commentCount}
          </span>
        )}
        <FileStatusLabel status={e.status} conflicted={e.conflicted} />
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
      </Button>
    </div>
  );
}

function DirRow({ node, depth, view, open, toggle }: RowProps & { node: DirNode; open: Set<string>; toggle: (p: string) => void }) {
  const isOpen = open.has(node.path);
  // Nothing below is left to review. The row has to say so itself: collapsed, it is the only sign,
  // and a directory that still hides an unread file looks exactly the same otherwise.
  const done = node.viewedCount === node.fileCount;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={`tree-row dir ${done ? 'viewed' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => toggle(node.path)}
        aria-expanded={isOpen}
        title={done ? `${node.path}（${node.fileCount} 个文件均已读）` : node.path}
      >
        <span className={`chev ${isOpen ? 'open' : ''}`} aria-hidden="true">
          ›
        </span>
        <TreeIcon kind="folder" />
        <span className="name">{node.name}</span>
        <span className="muted count">
          {done && <TreeIcon kind="check" />}
          {node.fileCount}
        </span>
      </Button>
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

  return (
    <section className="tree-block" aria-label={title}>
      <div className="block-head">
        <div className="block-heading">
          <span className="block-indicator" aria-hidden="true" />
          <span className="block-title">{title}</span>
          <span className="block-file-count" aria-label={`${files.length} 个文件`}>
            {files.length}
          </span>
          <span className="spacer" />
          <span className="tree-tools">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(new Set(hasExpandedDirectory ? [] : directories))}
              title={toggleLabel}
              aria-label={toggleLabel}
              disabled={directories.length === 0}
            >
              <TreeIcon kind={hasExpandedDirectory ? 'collapse' : 'expand'} />
            </Button>
          </span>
        </div>
        {files.length > 0 && (
          <div className="block-summary">
            <span className="block-diff-counts">
              <span className="add">+{add}</span>
              <span className="del">−{del}</span>
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
    <div className="progress" role="progressbar" aria-label={`文件${label}进度`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} title={hint}>
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

function DebugToggle() {
  const on = useStore((s) => s.prefs.ignoreDebug);
  const setIgnoreDebug = useStore((s) => s.setIgnoreDebug);
  return (
    <label className="side-toggle" title="折叠调试块和标了 nocommit 的行">
      <Checkbox checked={on} onCheckedChange={() => setIgnoreDebug(!on)} />
      忽略调试代码
    </label>
  );
}

/** What a checkpoint is called in a list: its number, its time, and why it exists when warden took it. */
function checkpointName(c: Checkpoint): string {
  return `#${c.id} · ${checkpointTime(c.createdAt)}${c.handoff ? ' · 交付反馈' : ''}`;
}

/** 14:05 for today, 9/21 14:05 before that. */
function checkpointTime(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * A checkpoint is the working tree as it was when the reviewer said "from here": whatever the agent
 * does next, staged, committed or neither, is then one diff against it. In the local views the bar
 * takes one and opens the newest; in a checkpoint's own view it switches between them, and taking
 * one there closes the round and moves on to the new one.
 */
function CheckpointBar({ target }: { target: Target }) {
  const checkpoints = useStore((s) => s.checkpoints);
  const setTarget = useStore((s) => s.setTarget);
  const createCheckpoint = useStore((s) => s.createCheckpoint);
  const deleteCheckpoint = useStore((s) => s.deleteCheckpoint);
  const wt = target.worktree ? { worktree: target.worktree } : {};
  const open = (id: number) => void setTarget(formatTargetKey({ kind: 'checkpoint', id, ...wt }));
  const take = (
    <Button variant="outline" size="sm" onClick={() => void createCheckpoint()} title="记录工作区快照（含未跟踪文件），用于比较后续变更；不写入仓库">
      新建检查点
    </Button>
  );

  if (target.kind === 'checkpoint') {
    const remove = () => {
      if (window.confirm(`删除检查点 #${target.id}？它上面的评论和已读标记会一起删除。`)) void deleteCheckpoint(target.id);
    };
    return (
      <div className="checkpoint-bar">
        <NativeSelect className="checkpoint-select" aria-label="对比的检查点" value={target.id} onChange={(e) => open(Number(e.target.value))}>
          {/* Listed before the checkpoints arrive, so the control never reads blank. */}
          {!checkpoints.some((c) => c.id === target.id) && <option value={target.id}>#{target.id}</option>}
          {checkpoints.map((c) => (
            <option key={c.id} value={c.id}>
              {checkpointName(c)}
            </option>
          ))}
        </NativeSelect>
        {take}
        <Button variant="ghost" size="sm" className="link" onClick={remove} title="删除这个检查点">
          删除
        </Button>
      </div>
    );
  }

  const newest = checkpoints.at(-1);
  return (
    <div className="checkpoint-bar">
      {newest ? (
        <Button
          variant="outline"
          size="sm"
          className="checkpoint-open"
          onClick={() => open(newest.id)}
          title={`只看检查点 ${checkpointName(newest)} 以后的改动${newest.handoff ? '：评论交给 agent 时自动记下的' : ''}`}
        >
          对比检查点 #{newest.id} · {checkpointTime(newest.createdAt)}
        </Button>
      ) : (
        <span className="checkpoint-none">暂无检查点</span>
      )}
      {take}
    </div>
  );
}

export function FileTree() {
  const files = useStore((s) => s.files);
  const loading = useStore((s) => s.filesLoading);
  const error = useStore((s) => s.filesError);
  const targetKey = useStore((s) => s.targetKey);
  const setTarget = useStore((s) => s.setTarget);

  const target = useMemo(() => tryParseTargetKey(targetKey), [targetKey]);
  // Keep expanded directories while refreshing the same worktree's comparison.
  const scope = commentScopeKey(targetKey);

  if (error) {
    // The view picker names any other target and its 工作区 is the way back, even when the listing
    // failed (a bad ref, say). A worktree target that failed to list is the one case where the way
    // back must leave the worktree: it may itself be what is wrong (removed while the page was
    // open), and every other control on the page, 工作区 included, would carry it along.
    return (
      <>
        {target?.worktree && (
          <div className="sidebar-target">
            <span className="sidebar-target-name" title={targetKey}>
              {targetLabel(target)}
            </span>
            <span className="spacer" />
            <Button variant="ghost" size="sm" className="link" onClick={() => void setTarget(formatTargetKey({ kind: 'all' }))} title="回到主仓库的工作区">
              ← 回到主仓库
            </Button>
          </div>
        )}
        <div className="error-box">{error}</div>
      </>
    );
  }

  return (
    <>
      <ReviewProgress done={files.filter((f) => f.viewed).length} total={files.length} label="已读" hint="勾选文件旁的框，或用文件头的“已读”标记" />
      <DebugToggle />
      {target?.kind === 'checkpoint' && <CheckpointBar target={target} />}
      <div className="tree-blocks">
        <TreeBlock key={scope} title="变更" view={targetKey} files={files} empty={loading ? '加载中…' : '暂无变更'} />
      </div>
    </>
  );
}
