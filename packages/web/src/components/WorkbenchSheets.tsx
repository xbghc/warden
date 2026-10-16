import { useState } from 'react';
import { LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import type { WorkspaceConfig } from '@warden/shared';
import { api } from '../api';
import { useWorkflow, workflowAction } from '../workflow-store';
import { useWorkbench } from '../workbench-store';
import { useWorkbenchData, errorMessage } from '../workbench-data';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Sheet } from './ui/sheet';
import { OperationError } from './TaskWorkspace';

function PlanForm() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const { busy, error, data } = useWorkflow();
  return (
    <form
      className="wb-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await workflowAction(() => api.createChange({ title: title.trim(), body: body.trim() }));
        if (result) {
          useWorkbench.getState().openTask(result.id);
          useWorkbench.getState().setSheet(null);
        }
      }}
    >
      <label className="wb-field">
        标题
        <Input
          aria-label="任务标题"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
          placeholder="例如：增加订单筛选参数"
        />
      </label>
      <label className="wb-field">
        说明（可选）
        <Textarea aria-label="任务说明" value={body} onChange={(event) => setBody(event.target.value)} rows={6} placeholder="目标与范围" />
      </label>
      <OperationError message={error} />
      {!data?.workflow && <p>请先在设置中选择主开发分支。</p>}
      <Button disabled={busy || !title.trim() || !data?.workflow}>{busy ? '添加中…' : '添加任务'}</Button>
    </form>
  );
}

function SettingsForm() {
  const { data, checkouts } = useWorkflow();
  const [branch, setBranch] = useState(data?.workflow?.developmentBranch ?? '');
  const [config, setConfig] = useState<WorkspaceConfig>(() => structuredClone(data?.workspaceConfig ?? { commands: [], hooks: {} }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const save = async (context: boolean) => {
    setPending(true);
    setError(null);
    setNotice('');
    try {
      if (context) await api.configureWorkflow(branch.trim());
      else await api.saveWorkspaceConfig(config);
      await Promise.all([useWorkflow.getState().refresh(), useWorkbenchData.getState().refresh()]);
      setNotice(context ? '主开发分支已保存' : '命令与脚本已保存');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="wb-form">
      <form
        className="wb-form-section"
        onSubmit={(event) => {
          event.preventDefault();
          void save(true);
        }}
      >
        <h2>主开发分支</h2>
        <p className="muted small">交付提交到此本地分支。</p>
        <Input
          aria-label="主开发分支"
          list="wb-development-branches"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="feature/order"
          required
        />
        <datalist id="wb-development-branches">
          {checkouts?.branches.map((item) => (
            <option key={item.name} value={item.name} />
          ))}
        </datalist>
        <Button variant="outline" size="icon-sm" disabled={pending || !branch.trim()} aria-label="保存分支" title="保存分支">
          <Save size={14} aria-hidden="true" />
        </Button>
      </form>
      <form
        className="wb-form-section"
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        <div className="wb-section-heading">
          <h2>终端命令</h2>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="添加命令"
            title="添加命令"
            onClick={() => setConfig({ ...config, commands: [...config.commands, { id: `command-${crypto.randomUUID()}`, label: '', text: '', keys: [] }] })}
          >
            <Plus size={14} aria-hidden="true" />
          </Button>
        </div>
        <p className="muted small">文本与按键依次发送到 tmux；添加 Enter 才会回车。</p>
        {config.commands.map((command, index) => (
          <div className="wb-command-editor" key={command.id}>
            <div className="wb-actions">
              <Input
                aria-label={`命令名称 ${index + 1}`}
                placeholder="名称，如“启动 agent”"
                value={command.label}
                required
                onChange={(event) =>
                  setConfig({ ...config, commands: config.commands.map((row) => (row.id === command.id ? { ...row, label: event.target.value } : row)) })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`删除命令 ${index + 1}`}
                title="删除命令"
                onClick={() => setConfig({ ...config, commands: config.commands.filter((row) => row.id !== command.id) })}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <Textarea
              aria-label={`命令文本 ${index + 1}`}
              rows={2}
              placeholder="命令文本"
              value={command.text ?? ''}
              onChange={(event) =>
                setConfig({ ...config, commands: config.commands.map((row) => (row.id === command.id ? { ...row, text: event.target.value } : row)) })
              }
            />
            <Input
              aria-label={`命令按键 ${index + 1}`}
              placeholder="按键（空格分隔）：Enter、C-c"
              value={command.keys?.join(' ') ?? ''}
              onChange={(event) =>
                setConfig({
                  ...config,
                  commands: config.commands.map((row) => (row.id === command.id ? { ...row, keys: event.target.value.split(/\s+/).filter(Boolean) } : row)),
                })
              }
            />
          </div>
        ))}
        <h2>工作区脚本</h2>
        <p className="muted small">在工作区目录执行，运行结果显示在任务中。</p>
        <label className="wb-field">
          创建时
          <Textarea
            aria-label="创建时脚本"
            rows={2}
            value={config.hooks.create ?? ''}
            onChange={(event) => setConfig({ ...config, hooks: { ...config.hooks, create: event.target.value } })}
          />
        </label>
        <label className="wb-field">
          复用时
          <Textarea
            aria-label="复用时脚本"
            rows={2}
            value={config.hooks.reuse ?? ''}
            onChange={(event) => setConfig({ ...config, hooks: { ...config.hooks, reuse: event.target.value } })}
          />
        </label>
        <details className="wb-description">
          <summary>脚本环境变量</summary>
          <p className="mono">WARDEN_WORKTREE · WARDEN_REPO · WARDEN_BRANCH · WARDEN_DEVELOPMENT_BRANCH · WARDEN_TASK_ID · WARDEN_HOOK_EVENT</p>
        </details>
        <Button size="icon" disabled={pending} aria-label="保存命令与脚本" title={pending ? '保存中…' : '保存命令与脚本'}>
          {pending ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
        </Button>
      </form>
      <OperationError message={error} />
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function WorkbenchSheets() {
  const sheet = useWorkbench((state) => state.sheet);
  return (
    <>
      <Sheet
        open={sheet === 'plan'}
        onOpenChange={(open) => {
          if (!open) useWorkbench.getState().setSheet(null);
        }}
        title="新增任务"
      >
        <PlanForm />
      </Sheet>
      <Sheet
        open={sheet === 'settings'}
        onOpenChange={(open) => {
          if (!open) useWorkbench.getState().setSheet(null);
        }}
        title="设置"
      >
        {sheet === 'settings' && <SettingsForm />}
      </Sheet>
    </>
  );
}
