import { branchOf, useStore } from '../store';
import { CommentRail } from './CommentRail';
import { TodoRail } from './TodoRail';
import { IssueRail } from './IssueRail';

/**
 * Right-hand rail: the three things the reviewer writes — line comments, the branch's todos and
 * local issues. It is shut by default and costs nothing when it is: 360px is most of the code
 * column once the window is a laptop's and the diff is side by side. Anything that puts content
 * in it (writing a comment, focusing one, re-attaching one) opens it from the store.
 */
export function Rail() {
  const open = useStore((s) => s.prefs.railOpen);
  const setRailOpen = useStore((s) => s.setRailOpen);
  const tab = useStore((s) => s.railTab);
  const setTab = useStore((s) => s.setRailTab);
  const commentCount = useStore((s) => s.comments.length);
  const repo = useStore((s) => s.repo);
  const root = useStore((s) => s.root);
  const branch = branchOf(repo, root);
  const todoCount = useStore((s) => s.todos.filter((t) => t.branch === branch && t.status === 'open').length);
  const issueCount = useStore((s) => s.issues.filter((i) => i.status === 'open').length);

  if (!open) return null;

  return (
    <aside className={`rail ${tab === 'issues' ? 'rail-wide' : ''}`}>
      <div className="rail-head">
        <div className="tabs" role="group" aria-label="右栏">
          <button className={`tab ${tab === 'comments' ? 'active' : ''}`} aria-pressed={tab === 'comments'} onClick={() => setTab('comments')}>
            评论
            {commentCount > 0 && <span className="tab-count">{commentCount}</span>}
          </button>
          <button
            className={`tab ${tab === 'todos' ? 'active' : ''}`}
            aria-pressed={tab === 'todos'}
            onClick={() => setTab('todos')}
            title={`${branch} 分支的待办`}
          >
            待办
            {todoCount > 0 && <span className="tab-count">{todoCount}</span>}
          </button>
          <button className={`tab ${tab === 'issues' ? 'active' : ''}`} aria-pressed={tab === 'issues'} onClick={() => setTab('issues')}>
            Issue
            {issueCount > 0 && <span className="tab-count">{issueCount}</span>}
          </button>
        </div>
        <span className="spacer" />
        <button className="icon quiet" onClick={() => setRailOpen(false)} title="收起 (Esc)" aria-label="收起右栏">
          ✕
        </button>
      </div>
      {tab === 'comments' ? <CommentRail /> : tab === 'todos' ? <TodoRail /> : <IssueRail />}
    </aside>
  );
}
