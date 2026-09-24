import { describe, expect, it } from 'vitest';
import type { Comment, Todo } from '@warden/shared';
import { formatCommentsExport, formatTodoExport, langForPath } from './export.js';

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

## src/features/order/OrderList.tsx:120-124 (new) [id: 1]
\`\`\`tsx
120 | const total = items.reduce((s, i) => s + i.price, 0);
121 | // ...
122 | 
123 | 
124 | 
\`\`\`
> 这里没有考虑 discount 字段，参考 utils/price.ts 里的 calcTotal。

## src/features/order/hooks/useOrder.ts:42 (new) [id: 2]
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
});

const todo = (over: Partial<Todo>): Todo => ({
  id: 't1',
  branch: 'feature/x',
  title: '补充 OrderList 的空状态',
  body: '',
  status: 'open',
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  ...over,
});

describe('todo export', () => {
  it('is the title alone when there is no body', () => {
    expect(formatTodoExport({ todo: todo({}), comments: [] })).toBe('补充 OrderList 的空状态');
    expect(formatTodoExport({ todo: todo({ body: '  \r\n' }), comments: [], replyCommand: 'warden' })).toBe('补充 OrderList 的空状态');
  });

  it('puts the body under the title and adds nothing: no branch, repo, number or status', () => {
    const text = formatTodoExport({ todo: todo({ body: '描述正文（Markdown）…\r\n\r\n- 第二段\r\n', status: 'done' }), comments: [] });
    expect(text).toBe('补充 OrderList 的空状态\n\n描述正文（Markdown）…\n\n- 第二段');
    expect(text).not.toMatch(/feature\/x|Branch|Repo|done|^#|^\d+\./m);
  });

  it('follows with the linked comments and how to answer them', () => {
    const text = formatTodoExport({ todo: todo({ body: 'Body **md**', commentIds: ['1'] }), comments: [c1], replyCommand: 'warden' });
    expect(text.startsWith('补充 OrderList 的空状态\n\nBody **md**\n\n## src/features/order/OrderList.tsx:120-124 (new) [id: 1]\n')).toBe(true);
    expect(text.endsWith('so the reviewer sees your answer beside it.')).toBe(true);
    expect(text).not.toMatch(/^# |Repo:|Count:/m);
  });
});
