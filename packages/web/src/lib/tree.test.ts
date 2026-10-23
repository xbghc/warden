import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@warden/shared';
import { allDirPaths, buildTree } from './tree';

const entry = (path: string): FileEntry => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
  contentHash: '',
});

describe('buildTree', () => {
  it('groups by directory, collapses single-child chains and sorts dirs before files', () => {
    const tree = buildTree([
      entry('src/features/order/OrderList.tsx'),
      entry('src/features/order/hooks/useOrder.ts'),
      entry('src/utils/a.ts'),
      entry('README.md'),
    ]);
    expect(tree.children.map((c) => `${c.kind}:${c.name}`)).toEqual(['dir:src', 'file:README.md']);
    const src = tree.children[0]!;
    if (src.kind !== 'dir') throw new Error();
    expect(src.fileCount).toBe(3);
    expect(src.children.map((c) => c.name)).toEqual(['features/order', 'utils']);
    expect(allDirPaths(tree)).toEqual(['src', 'src/features/order', 'src/features/order/hooks', 'src/utils']);
  });

  it('counts files through every level, collapsed chains included', () => {
    const tree = buildTree([
      entry('src/features/order/OrderList.tsx'),
      entry('src/features/order/hooks/useOrder.ts'),
      entry('src/utils/a.ts'),
      entry('src/utils/b.ts'),
      entry('README.md'),
    ]);
    const dirs = new Map<string, number>();
    const walk = (node: typeof tree) => {
      for (const c of node.children) {
        if (c.kind !== 'dir') continue;
        dirs.set(c.path, c.fileCount);
        walk(c);
      }
    };
    walk(tree);
    expect(Object.fromEntries(dirs)).toEqual({
      src: 4,
      'src/features/order': 2,
      'src/features/order/hooks': 1,
      'src/utils': 2,
    });
    expect(tree.fileCount).toBe(5);
  });
});
