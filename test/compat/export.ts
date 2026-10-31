import type { Todo } from '@warden/shared';

/** A task's title and notes, ready to copy to the user's own agent tools. */
export function formatTodoExport(todo: Todo): string {
  const body = todo.body.replace(/\r\n/g, '\n').trim();
  return [todo.title, ...(body ? [body] : [])].join('\n\n');
}
