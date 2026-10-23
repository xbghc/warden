import type { FileEntry } from '@warden/shared';

export interface DirNode {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  fileCount: number;
}
export interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  entry: FileEntry;
}
export type TreeNode = DirNode | FileNode;

interface Builder {
  dirs: Map<string, Builder>;
  files: FileEntry[];
}

function build(b: Builder, name: string, prefix: string): DirNode {
  const children: TreeNode[] = [];
  let fileCount = 0;
  const dirNames = [...b.dirs.keys()].sort((x, y) => x.localeCompare(y));
  for (const d of dirNames) {
    let node = build(b.dirs.get(d)!, d, prefix ? `${prefix}/${d}` : d);
    // Collapse single-child directory chains: a/b/c
    while (node.children.length === 1 && node.children[0]!.kind === 'dir') {
      const only = node.children[0] as DirNode;
      node = { ...only, name: `${node.name}/${only.name}` };
    }
    fileCount += node.fileCount;
    children.push(node);
  }
  for (const f of [...b.files].sort((x, y) => x.path.localeCompare(y.path))) {
    children.push({ kind: 'file', name: f.path.split('/').pop() ?? f.path, path: f.path, entry: f });
    fileCount++;
  }
  return { kind: 'dir', name, path: prefix, children, fileCount };
}

export function buildTree(files: FileEntry[]): DirNode {
  const root: Builder = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      let next = cur.dirs.get(p);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        cur.dirs.set(p, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return build(root, '', '');
}

export function allDirPaths(node: DirNode, out: string[] = []): string[] {
  for (const c of node.children) {
    if (c.kind === 'dir') {
      out.push(c.path);
      allDirPaths(c, out);
    }
  }
  return out;
}
