import { useEffect, useMemo, useState } from 'react';
import { branchOf, useStore } from '../store';
import { TaskList } from './TaskList';

/**
 * The Todo notebook of the rail: this branch's checklist, kept next to the comments it grows out
 * of. A branch is a list, the way Google Tasks has lists — the picker at the top switches between
 * the branches that have todos, and "所有分支" shows everything with the branch on each row.
 */
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

  /** `current`, `all`, or `b:<branch>`. */
  const [list, setList] = useState('current');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const others = useMemo(() => [...new Set(todos.map((t) => t.branch))].filter((b) => b !== branch).sort(), [todos, branch]);
  // A picked branch whose last todo is gone falls back to the current one.
  useEffect(() => {
    if (list.startsWith('b:') && !others.includes(list.slice(2))) setList('current');
  }, [list, others]);
  const shownBranch = list === 'all' ? null : list === 'current' ? branch : list.slice(2);
  const items = useMemo(
    () => todos.filter((t) => shownBranch === null || t.branch === shownBranch).map((t) => ({ ...t, done: t.status === 'done' })),
    [todos, shownBranch],
  );
  const openCount = items.filter((t) => !t.done).length;

  return (
    <>
      <div className="rail-tools">
        <select className="task-list-pick" value={list} onChange={(e) => setList(e.target.value)} aria-label="Todo 列表" title="哪个分支的 Todo">
          <option value="current">{branch}（当前分支）</option>
          {others.map((b) => (
            <option key={b} value={`b:${b}`}>
              {b}
            </option>
          ))}
          <option value="all">所有分支</option>
        </select>
        <span className="spacer" />
        <span className="muted">{openCount} 待办</span>
      </div>
      <div className="rail-list tasks">
        <button type="button" className="task-add" onClick={() => setAdding(true)} title="添加一条 Todo（回车可以连着写）">
          <span className="task-add-plus">+</span>
          添加 Todo
        </button>
        <TaskList
          items={items}
          adding={adding}
          onAddingChange={setAdding}
          titlePlaceholder="标题"
          doneLabel="已完成"
          emptyText={`${shownBranch ?? '所有分支'} 还没有 Todo。点上面的“添加 Todo”写第一条。`}
          allDoneText="全部完成了"
          onCreate={(title, after) => createTodo({ title, body: '', branch: shownBranch ?? branch, after })}
          onUpdate={(id, patch) => updateTodo(id, patch)}
          onToggle={(id, done) => updateTodo(id, { status: done ? 'done' : 'open' })}
          onDelete={deleteTodo}
          onMove={moveTodo}
          onClearDone={() => deleteTodos(items.filter((t) => t.done).map((t) => t.id))}
          meta={(t) => (shownBranch === null ? <span className="badge">{t.branch}</span> : null)}
          actions={(t) => (
            // One todo is one task for the agent: it goes over on its own, title and body only.
            <button type="button" className="link" onClick={() => void copyTodo(t.id)} title="只复制这条 Todo 的标题和描述">
              复制
            </button>
          )}
        />
      </div>
    </>
  );
}
