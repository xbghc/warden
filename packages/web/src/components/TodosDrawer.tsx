import { useEffect, useMemo, useState } from 'react';
import { ActionIcon } from './ActionIcon';
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

function TodoRow({ todo }: { todo: Todo }) {
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
                <ActionIcon name="save" label="保存" />
              </button>
              <button onClick={() => setEditing(false)}><ActionIcon name="close" label="取消" /></button>
            </div>
          </div>
        ) : (
          <div className="todo-body">
            {todo.body ? <Markdown text={todo.body} /> : <p className="muted">（无描述）</p>}
            <div className="row-actions">
              <button className="link" onClick={startEditing}>
                <ActionIcon name="edit" label="编辑" />
              </button>
              <button
                className="link danger"
                onClick={() => {
                  if (window.confirm(`删除 Todo「${todo.title}」？`)) void deleteTodo(todo.id);
                }}
              >
                <ActionIcon name="delete" label="删除" />
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
  const setPanel = useStore((s) => s.setPanel);
  const repo = useStore((s) => s.repo);
  const root = useStore((s) => s.root);
  const branch = branchOf(repo, root);

  const [filter, setFilter] = useState<Filter>('open');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    void loadTodos();
  }, [loadTodos, branch, root]);

  const shown = useMemo(
    () =>
      todos
        .filter((t) => t.branch === branch && (filter === 'all' || t.status === filter))
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    [todos, branch, filter],
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
            <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              <ActionIcon name={f === 'open' ? 'open' : f === 'done' ? 'done' : 'files'} label={f === 'open' ? '未完成' : f === 'done' ? '已完成' : '全部'} />
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button onClick={() => setCreating(true)}><ActionIcon name="add" label="新建" /></button>
        <button className="icon" onClick={() => setPanel('diff')} title="关闭 (Esc)">
          <ActionIcon name="close" label="关闭面板" />
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
              <ActionIcon name="add" label="创建 Todo" />
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setTitle('');
                setBody('');
              }}
            >
              <ActionIcon name="close" label="取消" />
            </button>
          </div>
        </div>
      )}
      <div className="todo-list">
        {shown.length === 0 && (
          <div className="muted empty">
            {`分支 ${branch} 上没有 ${filter === 'all' ? '' : filter} Todo`}
          </div>
        )}
        {shown.map((t) => (
          <TodoRow key={t.id} todo={t} />
        ))}
      </div>
    </aside>
  );
}
