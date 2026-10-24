import { describe, expect, it } from 'vitest';
import type { Todo } from '@warden/shared';
import { formatTodoExport } from './export.js';

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
    expect(formatTodoExport(todo({}))).toBe('补充 OrderList 的空状态');
    expect(formatTodoExport(todo({ body: '  \r\n' }))).toBe('补充 OrderList 的空状态');
  });

  it('puts the body under the title and adds nothing: no branch, repo, number or status', () => {
    const text = formatTodoExport(todo({ body: '描述正文（Markdown）…\r\n\r\n- 第二段\r\n', status: 'done' }));
    expect(text).toBe('补充 OrderList 的空状态\n\n描述正文（Markdown）…\n\n- 第二段');
    expect(text).not.toMatch(/feature\/x|Branch|Repo|done|^#|^\d+\./m);
  });
});
