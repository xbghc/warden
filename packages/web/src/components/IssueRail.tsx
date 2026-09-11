import { useEffect, useMemo, useState } from 'react';
import { ActionIcon } from './ActionIcon';
import { useStore } from '../store';
import { TaskList } from './TaskList';

export function IssueRail() {
  const issues = useStore((s) => s.issues);
  const loadIssues = useStore((s) => s.loadIssues);
  const createIssue = useStore((s) => s.createIssue);
  const updateIssue = useStore((s) => s.updateIssue);
  const deleteIssue = useStore((s) => s.deleteIssue);
  const deleteIssues = useStore((s) => s.deleteIssues);
  const moveIssue = useStore((s) => s.moveIssue);
  const exportIssue = useStore((s) => s.exportIssue);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);
  const items = useMemo(() => issues.map((i) => ({ ...i, done: i.status === 'closed' })), [issues]);

  return (
    <div className="rail-list tasks">
      <button type="button" className="task-add" onClick={() => setAdding(true)} title="添加一个 Issue（回车可以连着写）">
        <ActionIcon name="add" label="添加 Issue" />
      </button>
      <TaskList
        items={items}
        adding={adding}
        onAddingChange={setAdding}
        titlePlaceholder="标题"
        doneLabel="已关闭"
        emptyText="还没有 Issue。点上面的“添加 Issue”。"
        allDoneText="没有打开的 Issue"
        onCreate={(title, after) => createIssue({ title, body: '', after })}
        onUpdate={(id, patch) => updateIssue(id, patch)}
        onToggle={(id, done) => updateIssue(id, { status: done ? 'closed' : 'open' })}
        onDelete={deleteIssue}
        onMove={moveIssue}
        onClearDone={() => deleteIssues(items.filter((i) => i.done).map((i) => i.id))}
        actions={(i) => (
          <button type="button" className="link" onClick={() => void exportIssue(i.id)} title="复制 Issue">
            <ActionIcon name="copy" label="复制 Issue" />
          </button>
        )}
      />
    </div>
  );
}
