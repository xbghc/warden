import type { AcpProfile } from './contracts.js';

/** Executable profiles come only from user settings, never from conversation content. */
export function parseAcpProfiles(value: unknown): AcpProfile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error('warden.acpAgents must be an array of no more than 40 profiles.');
  const ids = new Set<string>();
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !v.includes('\0');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid agent profile.');
    const p = entry as Record<string, unknown>;
    if (!text(p.id, 100) || !/^[a-zA-Z0-9_-]+$/.test(p.id as string) || ids.has(p.id as string))
      throw new Error('Agent IDs must be unique and contain only letters, numbers, underscores and hyphens.');
    if (!text(p.label, 200) || !(p.label as string).trim() || !text(p.command, 4000) || !(p.command as string).trim())
      throw new Error('Agent profiles require a valid label and command.');
    if (p.args !== undefined && (!Array.isArray(p.args) || p.args.length > 100 || !p.args.every((arg) => text(arg, 8000))))
      throw new Error('Agent args must be an array of strings.');
    if (
      p.env !== undefined &&
      (!p.env ||
        typeof p.env !== 'object' ||
        Array.isArray(p.env) ||
        Object.entries(p.env).some(([key, val]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || !text(val, 16000)))
    )
      throw new Error('Agent env must map environment variable names to strings.');
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
