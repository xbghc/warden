import { useEffect, useState } from 'react';
import { Layers2, RefreshCw, Unplug } from 'lucide-react';
import { api } from '../api';
import { useWorkflow, workflowAction } from '../workflow-store';
import { useWorkbenchData, errorMessage } from '../workbench-data';
import { Button } from './ui/button';
import { OperationError } from './TaskWorkspace';

export function PreviewPage({ active }: { active: boolean }) {
  const { preview, errors, checking } = useWorkbenchData();
  const { data, busy } = useWorkflow();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
  }, [data?.workflow?.developmentBranch]);
  const names = (ids: string[]) => ids.map((id) => data?.workflow?.changes.find((task) => task.id === id)?.title ?? id).join(' + ');
  const run = () =>
    workflowAction(async () => {
      setPending(true);
      setError(null);
      try {
        useWorkbenchData.setState({ preview: await api.refreshPreview() });
      } catch (error) {
        setError(errorMessage(error));
        await useWorkbenchData.getState().refresh();
      } finally {
        setPending(false);
      }
    });
  const status = errors.preview ? 'stale' : preview?.status;
  return (
    <section className="wb-page wb-preview-page" hidden={!active} aria-label="主目录预览">
      <header className="wb-page-header">
        <div>
          <span className="wb-eyebrow">主开发分支 · {data?.workflow?.developmentBranch ?? '尚未选择'}</span>
          <h1>主目录预览</h1>
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={busy || checking || !preview}
          onClick={() => void run()}
          aria-label="刷新预览"
          title={pending ? '更新中…' : '刷新预览'}
        >
          <RefreshCw size={14} className={pending ? 'animate-spin' : undefined} aria-hidden="true" />
        </Button>
      </header>
      <div className="wb-page-content">
        <div className={`wb-preview-summary${status === 'stale' ? ' is-stale' : ''}`}>
          <span className="wb-summary-icon">
            {preview?.connectedIds.length ? <Layers2 size={24} strokeWidth={1.4} /> : <Unplug size={24} strokeWidth={1.4} />}
          </span>
          <div>
            <strong>
              {errors.preview
                ? '无法读取预览'
                : !preview
                  ? '加载预览…'
                  : status === 'paused'
                    ? '预览已暂停'
                    : status === 'stale'
                      ? '预览待更新'
                      : preview?.connectedIds.length
                        ? names(preview.connectedIds)
                        : '未连接工作区'}
            </strong>
            <p>{preview?.worktree ?? '主目录尚未配置'}</p>
            {preview?.updatedAt && <small>上次更新 {new Date(preview.updatedAt).toLocaleString('zh-CN')}</small>}
            {preview?.message && <p>{preview.message}</p>}
            {errors.preview && preview && <p>显示上次读取的预览。</p>}
          </div>
          {status === 'current' && <span className="wb-status">已更新</span>}
        </div>
        <OperationError message={error ?? errors.preview} />
        {!!preview?.conflicts?.length && (
          <div className="wb-error">
            <strong>冲突文件</strong>
            {preview.conflicts.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
