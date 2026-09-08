import { branchOf, useStore } from '../store';
import { CommentRail } from './CommentRail';
import { TodoRail } from './TodoRail';

/** Right-hand rail: the two things the reviewer writes — line comments and the branch's todos. */
export function Rail() {
  const tab = useStore((s) => s.railTab);
  const setTab = useStore((s) => s.setRailTab);
  const commentCount = useStore((s) => s.comments.length);
  const repo = useStore((s) => s.repo);
  const root = useStore((s) => s.root);
  const branch = branchOf(repo, root);
  const todoCount = useStore((s) => s.todos.filter((t) => t.branch === branch && t.status === 'open').length);

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="tabs" role="group" aria-label="右栏">
          <button className={`tab ${tab === 'comments' ? 'active' : ''}`} aria-pressed={tab === 'comments'} onClick={() => setTab('comments')}>
            评论
            {commentCount > 0 && <span className="tab-count">{commentCount}</span>}
          </button>
          <button className={`tab ${tab === 'todos' ? 'active' : ''}`} aria-pressed={tab === 'todos'} onClick={() => setTab('todos')} title={`${branch} 分支的 Todo`}>
            Todo
            {todoCount > 0 && <span className="tab-count">{todoCount}</span>}
          </button>
        </div>
      </div>
      {tab === 'comments' ? <CommentRail /> : <TodoRail />}
    </aside>
  );
}
