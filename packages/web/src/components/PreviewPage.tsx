import { useEffect, useState } from 'react';
import { Layers2, RefreshCw, Unplug } from 'lucide-react';
import { api } from '../api';
import { useWorkflow } from '../workflow-store';
import { useWorkbenchData, errorMessage } from '../workbench-data';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { OperationError } from './TaskWorkspace';

export function PreviewPage({ active }: { active: boolean }) {
  const { preview, errors, checking } = useWorkbenchData();
  const { data } = useWorkflow();
  const tasks =
    data?.workflow?.changes.filter((task) => task.worktree && task.status !== 'accepted' && task.developmentBranch === data.workflow?.developmentBranch) ?? [];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
  }, [data?.workflow?.developmentBranch]);
  const names = (ids: string[]) => ids.map((id) => data?.workflow?.changes.find((task) => task.id === id)?.title ?? id).join(' + ');
  const run = async (ids?: string[]) => {
    setPending(true);
    setError(null);
    try {
      useWorkbenchData.setState({ preview: ids ? await api.connectPreview(ids) : await api.refreshPreview() });
    } catch (error) {
      setError(errorMessage(error));
      await useWorkbenchData.getState().refresh();
    } finally {
      setPending(false);
    }
  };
  const status = errors.preview ? 'stale' : preview?.status;
  return (
    <section className="wb-page wb-preview-page" hidden={!active} aria-label="主目录预览">
      <header className="wb-page-header">
        <div>
          <span className="wb-eyebrow">主开发分支 · {data?.workflow?.developmentBranch ?? '尚未选择'}</span>
          <h1>主目录预览</h1>
          <p>把多个工作区的实时改动组合到主目录，沿用现有开发服务器。</p>
        </div>
        <Button variant="outline" size="sm" disabled={pending || checking || !preview} onClick={() => void run()}>
          <RefreshCw size={14} />
          {pending ? '更新中…' : '刷新预览'}
        </Button>
      </header>
      <div className="wb-page-content">
        <div className={`wb-preview-summary${status === 'stale' ? ' is-stale' : ''}`}>
          <span className="wb-summary-icon">
            {preview?.connectedIds.length ? <Layers2 size={24} strokeWidth={1.4} /> : <Unplug size={24} strokeWidth={1.4} />}
          </span>
          <div>
            <strong>
              {status === 'paused'
                ? '预览已暂停'
                : status === 'stale'
                  ? '预览尚未更新'
                  : preview?.connectedIds.length
                    ? names(preview.connectedIds)
                    : '尚未连接工作区'}
            </strong>
            <p>{preview?.worktree ?? '主目录尚未配置'}</p>
            {preview?.updatedAt && <small>最近成功更新：{new Date(preview.updatedAt).toLocaleString('zh-CN')}</small>}
            {preview?.message && <p>{preview.message}</p>}
            {errors.preview && <p>无法验证当前主目录内容，保留上次读取的信息。</p>}
          </div>
          {status && <span className="wb-status">{{ current: '当前', disconnected: '未连接', stale: '不新鲜', paused: '暂停' }[status]}</span>}
        </div>
        <OperationError message={error ?? errors.preview} />
        {!!preview?.conflicts?.length && (
          <div className="wb-error">
            <strong>以下文件存在冲突</strong>
            {preview.conflicts.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        )}
        <div className="wb-section-heading">
          <h2>连接工作区</h2>
          <span>连接与提交相互独立</span>
        </div>
        <div className="wb-table-wrap">
          <table className="wb-table">
            <thead>
              <tr>
                <th>连接</th>
                <th>工作区</th>
                <th>路径</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <Switch
                      aria-label={`连接 ${task.title}`}
                      checked={preview?.connectedIds.includes(task.id) ?? false}
                      disabled={pending || !preview || status === 'paused' || !!errors.preview}
                      onCheckedChange={(connected) =>
                        void run(connected ? [...preview!.connectedIds, task.id] : preview!.connectedIds.filter((id) => id !== task.id))
                      }
                    />
                  </td>
                  <td>
                    <strong>{task.title}</strong>
                    <small>{task.branch}</small>
                  </td>
                  <td>
                    <code>{task.worktree}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tasks.length === 0 && <div className="wb-empty-inline">工作计划中的任务创建工作区后，会显示在这里。</div>}
        </div>
        <div className="wb-section-heading">
          <h2>主目录中的组合文件</h2>
          <span>{preview?.files.length ?? 0} 个文件</span>
        </div>
        {preview?.files.length ? (
          <table className="wb-table">
            <thead>
              <tr>
                <th>文件</th>
                <th>贡献来源</th>
              </tr>
            </thead>
            <tbody>
              {preview.files.map((file) => (
                <tr key={file.path}>
                  <td>
                    <code>{file.path}</code>
                  </td>
                  <td>{names(file.changeIds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="wb-empty-inline">连接成功后，在这里查看组合涉及的文件。</div>
        )}
      </div>
    </section>
  );
}
