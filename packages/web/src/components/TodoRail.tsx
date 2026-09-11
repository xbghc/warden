import { ActionIcon } from './ActionIcon';
import { useEffect, useMemo, useState } from 'react';
import { branchOf, useStore } from '../store';
import { TaskList } from './TaskList';

/** The current branch’s checklist. */
export function TodoRail() {
  const todos = useStore((s) => s.todos);
  const loadTodos = useStore((s) => s.loadTodos);
  const createTodo = useStore((s) => s.createTodo);
  const updateTodo = useStore((s) => s.updateTodo);
  const deleteTodo = useStore((s) => s.deleteTodo);
  const deleteTodos = useStore((s) => s.deleteTodos);
  const moveTodo = useStore((s) => s.moveTodo);
  const copyTodo = useStore((s) => s.copyTodo);
  const repo = useStore((s) => s.repo);
  const root = useStore((s) => s.root);
  const branch = branchOf(repo, root);

  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos, branch, root]);

  const items = useMemo(() => todos.filter((t) => t.branch === branch).map((t) => ({ ...t, done: t.status === 'done' })), [todos, branch]);
  const openCount = items.filter((t) => !t.done).length;

  return (
    <>
      <div className="rail-tools">
        <span className="branch" title="当前分支">
          {branch}
        </span>
        <span className="spacer" />
        <span className="muted">{openCount} 待办</span>
      </div>
      <div className="rail-list tasks">
        <button type="button" className="task-add" onClick={() => setAdding(true)} title="添加一条待办（回车可以连着写）">
          <ActionIcon name="add" label="添加待办" />
        </button>
        <TaskList
          items={items}
          adding={adding}
          onAddingChange={setAdding}
          titlePlaceholder="标题"
          doneLabel="已完成"
          emptyText={`${branch} 还没有待办。点上面的“添加待办”写第一条。`}
          allDoneText="全部完成了"
          onCreate={(title, after) => createTodo({ title, body: '', branch, after })}
          onUpdate={(id, patch) => updateTodo(id, patch)}
          onToggle={(id, done) => updateTodo(id, { status: done ? 'done' : 'open' })}
          onDelete={deleteTodo}
          onMove={moveTodo}
          onClearDone={() => deleteTodos(items.filter((t) => t.done).map((t) => t.id))}
          actions={(t) => (
            // One todo is one task for the agent: it goes over on its own, title and body only.
            <button type="button" className="link" onClick={() => void copyTodo(t.id)} title="只复制这条 Todo 的标题和描述">
              <ActionIcon name="copy" label="复制 Todo" />
            </button>
          )}
        />
      </div>
    </>
  );
}
