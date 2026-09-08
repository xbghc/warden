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

function TodoRow({ todo, showBranch }: { todo: Todo; showBranch: boolean }) {
  const updateTodo = useStore((s) => s.updateTodo);
  const deleteTodo = useStore((s) => s.deleteTodo);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [body, setBody] = useState(todo.body);

  const startEditing = () => {
    setTitle(todo.title);
    setBody(todo.body);
    setEditing(true);
    setOpen(true);
  };

  return (
    <div className={`todo-row status-${todo.status}`}>
      <div className="todo-head" onClick={() => setOpen((v) => !v)}>
        <input
          type="checkbox"
          checked={todo.status === 'done'}
          onClick={(ev) => ev.stopPropagation()}
          onChange={() => void updateTodo(todo.id, { status: todo.status === 'done' ? 'open' : 'done' })}
          title={todo.status === 'done' ? '标记为未完成' : '标记为完成'}
        />
        <span className="title">{todo.title}</span>
        {showBranch && <span className="badge">{todo.branch}</span>}
        <span className="spacer" />
        <span className="muted small" title={todo.updatedAt}>
          {shortTime(todo.updatedAt)}
        </span>
      </div>
      {open &&
        (editing ? (
          <div className="issue-form">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" autoFocus />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="描述（Markdown，可选）" />
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
          <div className="todo-body">
            {todo.body ? <Markdown text={todo.body} /> : <p className="muted">（无描述）</p>}
            <div className="row-actions">
              <button className="link" onClick={startEditing}>
                编辑
              </button>
              <button
                className="link danger"
                onClick={() => {
                  if (window.confirm(`删除 Todo「${todo.title}」？`)) void deleteTodo(todo.id);
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

export function TodosDrawer() {
  const todos = useStore((s) => s.todos);
  const loadTodos = useStore((s) => s.loadTodos);
  const createTodo = useStore((s) => s.createTodo);
  const exportTodos = useStore((s) => s.exportTodos);
  const setPanel = useStore((s) => s.setPanel);
  const repo = useStore((s) => s.repo);
  const root = useStore((s) => s.root);
  const branch = branchOf(repo, root);

  const [filter, setFilter] = useState<Filter>('open');
  const [allBranches, setAllBranches] = useState(false);
  const [creating, setCreating] = useState(false);
  const [includeDone, setIncludeDone] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const shown = useMemo(
    () =>
      todos
        .filter((t) => (allBranches || t.branch === branch) && (filter === 'all' || t.status === filter))
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    [todos, allBranches, branch, filter],
  );

  return (
    <aside className="issues-drawer">
      <div className="drawer-head">
        <strong>Todos</strong>
        <span className="branch" title="当前分支">
          {branch || '-'}
        </span>
        <div className="seg">
          {(['open', 'done', 'all'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button onClick={() => setCreating(true)}>新建</button>
        <button className="icon" onClick={() => setPanel('diff')} title="关闭 (Esc)">
          ✕
        </button>
      </div>
      <div className="drawer-tools">
        <label className="check">
          <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} />
          所有分支
        </label>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
          含已完成
        </label>
        <button className="link" onClick={() => void exportTodos(includeDone)} title={`复制 ${branch} 的 Todo`}>
          复制 Todo
        </button>
      </div>
      {creating && (
        <div className="issue-form">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" autoFocus />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="描述（Markdown，可选）" />
          <div className="muted">将创建在分支 {branch}</div>
          <div className="row-actions">
            <button
              className="primary"
              disabled={!title.trim()}
              onClick={async () => {
                const todo = await createTodo({ title, body });
                if (todo) {
                  setTitle('');
                  setBody('');
                  setCreating(false);
                }
              }}
            >
              创建 Todo
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setTitle('');
                setBody('');
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <div className="todo-list">
        {shown.length === 0 && (
          <div className="muted empty">
            {allBranches ? '还没有 Todo' : `分支 ${branch} 上没有 ${filter === 'all' ? '' : filter} Todo`}
          </div>
        )}
        {shown.map((t) => (
          <TodoRow key={t.id} todo={t} showBranch={allBranches} />
        ))}
      </div>
    </aside>
  );
}
