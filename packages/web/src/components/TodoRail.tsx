import { useEffect, useMemo, useState } from 'react';
import type { Todo } from '@warden/shared';
import { branchOf, useStore } from '../store';
import { Markdown } from './Markdown';

type Filter = 'open' | 'done' | 'all';

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

function TodoCard({ todo, showBranch }: { todo: Todo; showBranch: boolean }) {
  const updateTodo = useStore((s) => s.updateTodo);
  const deleteTodo = useStore((s) => s.deleteTodo);
  const copyTodo = useStore((s) => s.copyTodo);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [body, setBody] = useState(todo.body);
  const done = todo.status === 'done';

  const startEditing = () => {
    setTitle(todo.title);
    setBody(todo.body);
    setEditing(true);
    setOpen(true);
  };

  return (
    <div className={`todo-card status-${todo.status}`}>
      <div className="todo-head" onClick={() => setOpen((v) => !v)}>
        <input
          type="checkbox"
          checked={done}
          onClick={(ev) => ev.stopPropagation()}
          onChange={() => void updateTodo(todo.id, { status: done ? 'open' : 'done' })}
          title={done ? '标记为未完成' : '标记为完成'}
        />
        <span className="title">{todo.title}</span>
        {showBranch && <span className="badge">{todo.branch}</span>}
        <span className="time" title={todo.updatedAt}>
          {shortTime(todo.updatedAt)}
        </span>
        <span className="card-actions">
          {/* One todo is one task for the agent: it goes over on its own, title and body only. */}
          <button
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              void copyTodo(todo.id);
            }}
            title="只复制这条 Todo 的标题和描述"
          >
            复制
          </button>
          <button
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              startEditing();
            }}
          >
            编辑
          </button>
          <button
            className="link danger"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`删除 Todo「${todo.title}」？`)) void deleteTodo(todo.id);
            }}
          >
            删除
          </button>
        </span>
      </div>
      {open &&
        (editing ? (
          <div className="todo-edit">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" autoFocus />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="描述（Markdown，可选）" />
            <div className="row-actions">
              <button
                className="primary"
                disabled={!title.trim()}
                onClick={async () => {
                  await updateTodo(todo.id, { title, body });
                  setEditing(false);
                }}
              >
                保存
              </button>
              <button onClick={() => setEditing(false)}>取消</button>
            </div>
          </div>
        ) : (
          <div className="todo-body">{todo.body ? <Markdown text={todo.body} /> : <p className="muted">没有描述</p>}</div>
        ))}
    </div>
  );
}

/** The Todo notebook of the rail: this branch's checklist, kept next to the comments it grows out of. */
export function TodoRail() {
  const todos = useStore((s) => s.todos);
  const loadTodos = useStore((s) => s.loadTodos);
  const createTodo = useStore((s) => s.createTodo);
  const repo = useStore((s) => s.repo);
  const root = useStore((s) => s.root);
  const branch = branchOf(repo, root);

  const [filter, setFilter] = useState<Filter>('open');
  const [allBranches, setAllBranches] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const pool = useMemo(() => (allBranches ? todos : todos.filter((t) => t.branch === branch)), [todos, allBranches, branch]);
  const shown = useMemo(
    () =>
      pool
        .filter((t) => filter === 'all' || t.status === filter)
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    [pool, filter],
  );
  const filters: [Filter, string, number][] = [
    ['open', 'open', pool.filter((t) => t.status === 'open').length],
    ['done', 'done', pool.filter((t) => t.status === 'done').length],
    ['all', 'all', pool.length],
  ];
  const emptyText = filter === 'done' ? '没有已完成的 Todo' : filter === 'open' && pool.length > 0 ? '全部完成了' : '还没有 Todo，在上面写第一条。';

  const submit = async () => {
    const title = draft.trim();
    if (!title) return;
    const todo = await createTodo({ title, body: '' });
    if (todo) setDraft('');
  };

  return (
    <>
      <div className="rail-tools">
        <div className="seg small" role="group" aria-label="Todo 筛选">
          {filters.map(([key, label, n]) => (
            <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
              <span className="tab-count">{n}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} />
          所有分支
        </label>
      </div>
      <div className="rail-list">
        <form
          className="todo-add"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`给 ${branch} 添加 Todo，回车创建`} aria-label="新 Todo" />
        </form>
        {shown.length === 0 && <div className="muted empty">{emptyText}</div>}
        {shown.map((t) => (
          <TodoCard key={t.id} todo={t} showBranch={allBranches} />
        ))}
      </div>
    </>
  );
}
