import { describe, expect, it } from 'vitest';
import type { Comment } from '@warden/shared';
import { formatCommentsExport, formatIssueExport, langForPath } from './export.js';

const anchor = { hunkHash: '', lineHashes: [], contextBefore: [], contextAfter: [], hunkLineOffset: 0 };

const c1: Comment = {
  id: '1',
  targetKey: 'working',
  filePath: 'src/features/order/OrderList.tsx',
  side: 'new',
  startLine: 120,
  endLine: 124,
  codeSnippet: ['const total = items.reduce((s, i) => s + i.price, 0);', '// ...', '', '', ''],
  body: '这里没有考虑 discount 字段，参考 utils/price.ts 里的 calcTotal。',
  status: 'active',
  anchor,
  createdAt: '',
  updatedAt: '',
};
const c2: Comment = {
  ...c1,
  id: '2',
  filePath: 'src/features/order/hooks/useOrder.ts',
  startLine: 42,
  endLine: 42,
  codeSnippet: ['useEffect(() => { fetchOrder(id) }, []);'],
  body: '依赖数组缺少 id。\n\n第二段。',
};

describe('export format', () => {
  it('matches the documented layout', () => {
    const text = formatCommentsExport({ repoRoot: '/home/user/project', comments: [c1, c2] });
    expect(text).toBe(`# Review comments
Target: working
Repo: /home/user/project
Count: 2

## src/features/order/OrderList.tsx:120-124 (new)
\`\`\`tsx
120 | const total = items.reduce((s, i) => s + i.price, 0);
121 | // ...
122 | 
123 | 
124 | 
\`\`\`
> 这里没有考虑 discount 字段，参考 utils/price.ts 里的 calcTotal。

## src/features/order/hooks/useOrder.ts:42 (new)
\`\`\`ts
42 | useEffect(() => { fetchOrder(id) }, []);
\`\`\`
> 依赖数组缺少 id。
>
> 第二段。
`);
  });
  it('pads line numbers when the range crosses a digit boundary', () => {
    const text = formatCommentsExport({
      repoRoot: '/r',
      comments: [{ ...c1, startLine: 8, endLine: 11, codeSnippet: ['a', 'b', 'c', 'd'] }],
    });
    expect(text).toContain(' 8 | a\n 9 | b\n10 | c\n11 | d');
  });
  it('maps extensions to fence languages', () => {
    expect(langForPath('a/b.tsx')).toBe('tsx');
    expect(langForPath('x.py')).toBe('python');
    expect(langForPath('Makefile')).toBe('');
    expect(langForPath('x.unknownext')).toBe('unknownext');
  });
  it('formats issues with body and linked comments', () => {
    const text = formatIssueExport({
      repoRoot: '/r',
      issue: { id: 'i', title: 'Fix totals', body: 'Body **md**', status: 'open', commentIds: ['1'], createdAt: '', updatedAt: '' },
      comments: [c1],
    });
    expect(text.startsWith('# Issue: Fix totals\nStatus: open\nTarget: working\nRepo: /r\nCount: 1\n\nBody **md**\n\n## src/')).toBe(true);
  });
});
