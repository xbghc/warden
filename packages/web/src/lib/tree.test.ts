import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@warden/shared';
import { allDirPaths, buildTree } from './tree';

const entry = (path: string, viewed = false): FileEntry => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
  contentHash: '',
  viewed,
  changed: false,
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

  it('counts viewed files through every level, collapsed chains included', () => {
    const tree = buildTree([
      entry('src/features/order/OrderList.tsx', true),
      entry('src/features/order/hooks/useOrder.ts', true),
      entry('src/utils/a.ts', true),
      entry('src/utils/b.ts'),
      entry('README.md', true),
    ]);
    const dirs = new Map<string, [number, number]>();
    const walk = (node: typeof tree) => {
      for (const c of node.children) {
        if (c.kind !== 'dir') continue;
        dirs.set(c.path, [c.viewedCount, c.fileCount]);
        walk(c);
      }
    };
    walk(tree);
    expect(Object.fromEntries(dirs)).toEqual({
      src: [3, 4],
      'src/features/order': [2, 2],
      'src/features/order/hooks': [1, 1],
      'src/utils': [1, 2],
    });
    expect([tree.viewedCount, tree.fileCount]).toEqual([4, 5]);
  });
});
