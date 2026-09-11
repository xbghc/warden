import { useEffect, useState } from 'react';
import { ActionIcon } from './ActionIcon';
import type { Issue } from '@warden/shared';
import { useStore } from '../store';
import { Markdown } from './Markdown';

type Filter = 'open' | 'closed' | 'all';

function IssueDetail({ issue, onBack }: { issue: Issue; onBack: () => void }) {
  const updateIssue = useStore((s) => s.updateIssue);
  const deleteIssue = useStore((s) => s.deleteIssue);
  const exportIssue = useStore((s) => s.exportIssue);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body);

  return (
    <div className="issue-detail">
      <div className="issue-detail-head">
        <button className="link" onClick={onBack}>
          <ActionIcon name="back" label="返回列表" />
        </button>
        <span className="spacer" />
        <button className="link" onClick={() => void exportIssue(issue.id)}>
          <ActionIcon name="copy" label="复制 Issue" />
        </button>
        <button className="link" onClick={() => void updateIssue(issue.id, { status: issue.status === 'open' ? 'closed' : 'open' })}>
          <ActionIcon name={issue.status === 'open' ? 'done' : 'open'} label={issue.status === 'open' ? '关闭' : '重新打开'} />
        </button>
        <button
          className="link danger"
          onClick={() => {
            if (window.confirm(`删除 Issue「${issue.title}」？`)) {
              void deleteIssue(issue.id);
              onBack();
            }
          }}
        >
          <ActionIcon name="delete" label="删除" />
        </button>
      </div>
      {editing ? (
        <div className="issue-form">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="描述（Markdown）" />
          <div className="row-actions">
            <button
              className="primary"
              disabled={!title.trim()}
              onClick={async () => {
                await updateIssue(issue.id, { title, body });
                setEditing(false);
              }}
            >
              <ActionIcon name="save" label="保存" />
            </button>
            <button onClick={() => setEditing(false)}><ActionIcon name="close" label="取消" /></button>
          </div>
        </div>
      ) : (
        <>
          <h3>
            <span className={`badge badge-${issue.status}`}>{issue.status}</span> {issue.title}
            <button className="link" onClick={() => setEditing(true)}>
              <ActionIcon name="edit" label="编辑" />
            </button>
          </h3>
          {issue.body ? <Markdown text={issue.body} /> : <p className="muted">（无描述）</p>}
        </>
      )}

    </div>
  );
}

export function IssuesDrawer() {
  const issues = useStore((s) => s.issues);
  const loadIssues = useStore((s) => s.loadIssues);
  const createIssue = useStore((s) => s.createIssue);
  const setPanel = useStore((s) => s.setPanel);
  const [filter, setFilter] = useState<Filter>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  const shown = issues.filter((i) => filter === 'all' || i.status === filter);
  const open = openId ? issues.find((i) => i.id === openId) : undefined;

  return (
    <aside className="issues-drawer">
      <div className="drawer-head">
        <strong>Issues</strong>
        <div className="seg">
          {(['open', 'closed', 'all'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              <ActionIcon name={f === 'open' ? 'open' : f === 'closed' ? 'done' : 'files'} label={f === 'open' ? '未关闭' : f === 'closed' ? '已关闭' : '全部'} />
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button onClick={() => setCreating(true)}><ActionIcon name="add" label="新建" /></button>
        <button className="icon" onClick={() => setPanel('diff')} title="关闭 (Esc)">
          <ActionIcon name="close" label="关闭面板" />
        </button>
      </div>
      {open ? (
        <IssueDetail issue={open} onBack={() => setOpenId(null)} />
      ) : (
        <>
          {creating && (
            <div className="issue-form">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" autoFocus />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="描述（Markdown，可选）" />
              <div className="row-actions">
                <button
                  className="primary"
                  disabled={!title.trim()}
                  onClick={async () => {
                    const issue = await createIssue({ title, body });
                    if (issue) {
                      setTitle('');
                      setBody('');
                      setCreating(false);
                      setOpenId(issue.id);
                    }
                  }}
                >
                  <ActionIcon name="check" label="创建 Issue" />
                </button>
                <button
                  onClick={() => {
                    setCreating(false);
                  }}
                >
                  <ActionIcon name="close" label="取消" />
                </button>
              </div>
            </div>
          )}
          <div className="issue-list">
            {shown.length === 0 && <div className="muted empty">没有 {filter === 'all' ? '' : filter} Issue</div>}
            {shown.map((i) => (
              <div key={i.id} className="issue-row" onClick={() => setOpenId(i.id)}>
                <span className={`badge badge-${i.status}`}>{i.status}</span>
                <span className="title">{i.title}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
