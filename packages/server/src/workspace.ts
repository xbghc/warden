import { execFile } from 'node:child_process';
import type { DevelopmentChange, WorkspaceConfig, WorkspaceHookResult } from '@warden/shared';
import { badRequest } from './errors.js';

export const emptyWorkspaceConfig = (): WorkspaceConfig => ({ commands: [], hooks: {} });

/** Configuration is saved explicitly by the user, never loaded from a task branch. */
export function workspaceConfig(value: unknown): WorkspaceConfig {
  if (!value || typeof value !== 'object') throw badRequest('工作区配置必须是对象');
  const row = value as WorkspaceConfig;
  if (!Array.isArray(row.commands) || row.commands.length > 30 || !row.hooks || typeof row.hooks !== 'object' || Array.isArray(row.hooks))
    throw badRequest('请提供 commands 数组和 hooks 对象');
  const ids = new Set<string>();
  const commands = row.commands.map((command) => {
    if (!command || typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(command.id) || ids.has(command.id))
      throw badRequest('命令 id 必须唯一，使用字母、数字、下划线或连字符');
    ids.add(command.id);
    if (typeof command.label !== 'string' || !command.label.trim() || command.label.length > 80) throw badRequest('请填写命令名称');
    if (command.text !== undefined && (typeof command.text !== 'string' || command.text.length > 20000 || command.text.includes('\0')))
      throw badRequest('命令文本格式错误或超过 20000 字');
    if (
      command.keys !== undefined &&
      (!Array.isArray(command.keys) || command.keys.length > 32 || command.keys.some((key) => typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(key)))
    )
      throw badRequest('keys 应是 tmux 按键名称数组，例如 Enter、C-c');
    if (!command.text && !command.keys?.length) throw badRequest('命令需要文本或按键');
    return {
      id: command.id,
      label: command.label.trim(),
      ...(command.text ? { text: command.text } : {}),
      ...(command.keys?.length ? { keys: command.keys } : {}),
    };
  });
  const hooks: WorkspaceConfig['hooks'] = {};
  for (const event of ['create', 'reuse'] as const) {
    const command = row.hooks[event];
    if (command !== undefined && (typeof command !== 'string' || command.length > 20000 || command.includes('\0')))
      throw badRequest('hook 应是 shell 命令字符串');
    if (command?.trim()) hooks[event] = command;
  }
  return { commands, hooks };
}

/** A thin shell-command hook: cwd and environment in, output and exit status out. */
export function runWorkspaceHook(root: string, change: DevelopmentChange, event: 'create' | 'reuse', command: string): Promise<WorkspaceHookResult> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd: change.worktree,
        timeout: 60000,
        maxBuffer: 128 * 1024,
        env: {
          ...process.env,
          WARDEN_REPO: root,
          WARDEN_WORKTREE: change.worktree,
          WARDEN_BRANCH: change.branch,
          WARDEN_DEVELOPMENT_BRANCH: change.developmentBranch,
          WARDEN_TASK_ID: change.id,
          WARDEN_HOOK_EVENT: event,
        },
      },
      (error, stdout, stderr) =>
        resolve({
          event,
          command,
          status: error ? 'failed' : 'succeeded',
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          output: [stdout, stderr, error?.message].filter(Boolean).join('\n').slice(-16000),
        }),
    );
  });
}
