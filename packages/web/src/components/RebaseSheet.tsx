import { useEffect, useState } from 'react';
import type { RebaseBatchResponse, RebaseCheck } from '@warden/shared';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useWorkflow } from '../workflow-store';
import { useWorkbench } from '../workbench-store';
import { useWorkbenchData, errorMessage } from '../workbench-data';
import { useStore } from '../store';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Sheet } from './ui/sheet';
import { OperationError } from './TaskWorkspace';

export const checkLabel = (check?: RebaseCheck) =>
  check ? { current: '已同步', ready: '预计可同步', conflict: '预计冲突', blocked: '暂不可同步', unknown: '无法判断' }[check.status] : '未检查';

export function RebaseSheet() {
  const open = useWorkbench((state) => state.sheet === 'sync');
  const { checks, errors, checking } = useWorkbenchData();
  const { data, checkouts } = useWorkflow();
  const tasks =
    data?.workflow?.changes.filter((task) => task.worktree && task.status !== 'accepted' && task.developmentBranch === data.workflow?.developmentBranch) ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<RebaseBatchResponse['results']>([]);
  useEffect(() => {
    setSelected([]);
    setResults([]);
    setError(null);
  }, [data?.workflow?.developmentBranch]);
  const stale = (check?: RebaseCheck) =>
    !check ||
    !!errors.checks ||
    check.developmentHead !== data?.developmentHead ||
    check.sourceHead !== checkouts?.worktrees.find((row) => row.path === tasks.find((task) => task.id === check.changeId)?.worktree)?.head;
  const run = async () => {
    setPending(true);
    setError(null);
    setResults([]);
    const items = checks.filter((check) => selected.includes(check.changeId) && check.status === 'ready' && !stale(check));
    const skipped: RebaseBatchResponse['results'] = selected
      .filter((id) => !items.some((check) => check.changeId === id))
      .map((changeId) => {
        const check = checks.find((row) => row.changeId === changeId);
        return { changeId, status: 'skipped', message: stale(check) ? '请重新检查' : (check?.message ?? checkLabel(check)) };
      });
    try {
      const response = items.length
        ? await api.rebaseWorkspaces({ items: items.map(({ changeId, sourceHead, developmentHead }) => ({ changeId, sourceHead, developmentHead })) })
        : { results: [] };
      setResults([...response.results, ...skipped]);
      await Promise.all([useWorkflow.getState().refresh(), useWorkbenchData.getState().refresh(), useStore.getState().refresh()]);
    } catch (error) {
      setError(errorMessage(error));
      setResults(skipped);
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) useWorkbench.getState().setSheet(null);
      }}
      title="同步工作区"
      description={`基于 ${data?.workflow?.developmentBranch ?? '主开发分支'} · ${data?.developmentHead?.slice(0, 8) ?? '未知版本'}`}
      wide
    >
      <div className="wb-form">
        <div className="wb-actions">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="重新检查"
            title={checking ? '检查中…' : '重新检查'}
            disabled={checking || pending}
            onClick={() => void Promise.all([useWorkflow.getState().refresh(), useWorkbenchData.getState().refresh()])}
          >
            <RefreshCw size={14} className={checking ? 'animate-spin' : undefined} aria-hidden="true" />
          </Button>
          {checks[0]?.checkedAt && <span className="muted small">检查于 {new Date(checks[0].checkedAt).toLocaleTimeString('zh-CN')}</span>}
        </div>
        <OperationError message={error ?? errors.checks} />
        <table className="wb-table wb-rebase-table">
          <thead>
            <tr>
              <th>
                <Checkbox
                  aria-label="选择全部工作区"
                  checked={tasks.length > 0 && tasks.every((task) => selected.includes(task.id))}
                  onCheckedChange={(value) => setSelected(value === true ? tasks.map((task) => task.id) : [])}
                />
              </th>
              <th>工作区</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const check = checks.find((row) => row.changeId === task.id);
              const result = results.find((row) => row.changeId === task.id);
              return (
                <tr key={task.id}>
                  <td>
                    <Checkbox
                      aria-label={`选择 ${task.title}`}
                      checked={selected.includes(task.id)}
                      disabled={pending}
                      onCheckedChange={(value) => setSelected(value === true ? [...selected, task.id] : selected.filter((id) => id !== task.id))}
                    />
                  </td>
                  <td>
                    <strong>{task.title}</strong>
                    <small>{task.branch}</small>
                  </td>
                  <td>
                    {result ? (
                      <div className={`wb-batch-result${result.status === 'failed' ? ' has-error' : ''}`}>
                        {{ updated: '已同步', skipped: '已跳过', failed: '同步失败' }[result.status]}
                        {result.message && `：${result.message}`}
                      </div>
                    ) : (
                      <>
                        <span>{errors.checks ? '检查失败' : check && stale(check) ? '需重新检查' : checkLabel(check)}</span>
                        {check?.message && <small>{check.message}</small>}
                        {check?.files?.map((path) => (
                          <code key={path}>{path}</code>
                        ))}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {tasks.length === 0 && <p className="wb-empty-inline">暂无工作区</p>}
        <p className="muted small">通过 rebase 同步。执行前复查状态，仅同步预计可同步的工作区，保留已有修改。</p>
        <Button disabled={pending || !selected.some((id) => tasks.some((task) => task.id === id))} onClick={() => void run()}>
          {pending ? '同步中…' : `同步所选（${selected.filter((id) => tasks.some((task) => task.id === id)).length}）`}
        </Button>
      </div>
    </Sheet>
  );
}
