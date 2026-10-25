import type { AcpProfile } from './contracts.js';

/** Executable profiles come only from user settings, never from conversation content. */
export function parseAcpProfiles(value: unknown): AcpProfile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error('warden.acpAgents 必须是最多 40 项的配置数组');
  const ids = new Set<string>();
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !v.includes('\0');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Agent 配置格式错误');
    const p = entry as Record<string, unknown>;
    if (!text(p.id, 100) || !/^[a-zA-Z0-9_-]+$/.test(p.id as string) || ids.has(p.id as string))
      throw new Error('Agent id 必须唯一，只能包含字母、数字、下划线和连字符');
    if (!text(p.label, 200) || !(p.label as string).trim() || !text(p.command, 4000) || !(p.command as string).trim())
      throw new Error('Agent 配置需要有效的 label 和 command');
    if (p.args !== undefined && (!Array.isArray(p.args) || p.args.length > 100 || !p.args.every((arg) => text(arg, 8000))))
      throw new Error('Agent args 必须是字符串数组');
    if (
      p.env !== undefined &&
      (!p.env ||
        typeof p.env !== 'object' ||
        Array.isArray(p.env) ||
        Object.entries(p.env).some(([key, val]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || !text(val, 16000)))
    )
      throw new Error('Agent env 必须是环境变量名称到字符串的映射');
    ids.add(p.id as string);
    return {
      id: p.id as string,
      label: p.label as string,
      command: p.command as string,
      args: (p.args as string[] | undefined) ?? [],
      ...(p.env === undefined ? {} : { env: p.env as Record<string, string> }),
    };
  });
}
