import type { Todo } from '@warden/shared';

/**
 * A todo as it goes to the clipboard: the title, then the body when there is one — and nothing
 * else. It is pasted at an agent already working in the todo's branch, so the branch, the repo and
 * the other todos would only be noise: one todo is one task for the agent.
 */
export function todoText(todo: Todo): string {
  const body = todo.body.replace(/\r\n/g, '\n').trim();
  return body ? `${todo.title}\n\n${body}` : todo.title;
}
