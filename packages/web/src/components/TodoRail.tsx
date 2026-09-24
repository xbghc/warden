import { ActionIcon } from './ActionIcon';
import { useEffect, useMemo, useState } from 'react';
import type { Comment, Todo } from '@warden/shared';
import { branchOf, useStore } from '../store';
import { TaskList } from './TaskList';

/** The comments a todo carries, under its open row: where each is, what it says, and a way there. */
function LinkedComments({ todo }: { todo: Todo }) {
  const allComments = useStore((s) => s.allComments);
  const comments = useStore((s) => s.comments);
  const jumpToComment = useStore((s) => s.jumpToComment);
  const unlinkComment = useStore((s) => s.unlinkComment);
  const byId = useMemo(() => new Map<string, Comment>([...allComments, ...comments].map((c) => [c.id, c])), [allComments, comments]);
  const linked = (todo.commentIds ?? []).map((id) => byId.get(id)).filter((c): c is Comment => !!c);
  if (linked.length === 0) {
    return <div className="task-subs task-sub-none">在评论卡片上点“加入待办”，评论会随这条待办一起复制给 agent。</div>;
  }
  return (
    <div className="task-subs">
      {linked.map((c) => (
        <div key={c.id} className={`task-sub status-${c.status}`}>
          <span className="task-sub-dot" aria-hidden="true" />
          <div className="task-sub-main">
            <div className="task-sub-head">
              <span className="mono">
                {c.filePath.split('/').pop()}:{c.startLine === c.endLine ? c.startLine : `${c.startLine}-${c.endLine}`}
              </span>
              <span className="task-actions">
                {c.status !== 'orphaned' && (
                  <button type="button" className="link" onClick={() => void jumpToComment(c)} title={`跳到 ${c.filePath}`}>
                    <ActionIcon name="forward" label="跳转" />
                  </button>
                )}
                <button type="button" className="link" onClick={() => void unlinkComment(todo.id, c.id)} title="从这条待办移除，评论本身保留">
                  <ActionIcon name="unlink" label="解除关联" />
                </button>
              </span>
            </div>
            <div className="task-sub-body">{c.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

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
          meta={(t) =>
            t.commentIds?.length ? (
              <span className="badge badge-active" title={`带着 ${t.commentIds.length} 条评论`}>
                {t.commentIds.length} 条评论
              </span>
            ) : null
          }
          extra={(t) => <LinkedComments todo={t} />}
          actions={(t) => (
            // One todo is one task for the agent: it goes over on its own, with the comments it carries.
            <button type="button" className="link" onClick={() => void copyTodo(t.id)} title="复制这条待办：标题、描述和它带的评论">
              <ActionIcon name="copy" label="复制待办" />
            </button>
          )}
        />
      </div>
    </>
  );
}
