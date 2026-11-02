import type { AcpProfile } from './contracts.js';

export const acpPresets = [
  { id: 'codex', label: 'Codex', command: 'codex-acp', args: [], detail: 'Requires the codex-acp adapter. Install it on the workspace host first.' },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    detail: "Uses OpenCode's built-in ACP support. Install OpenCode on the workspace host first.",
  },
] as const;

export function presetCommandError(command: string, platform = process.platform): string | undefined {
  if (!command.trim() || command.length > 4000 || command.includes('\0')) return 'Enter a valid executable name or absolute path.';
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command))
    return 'Choose a native executable (.exe). Batch wrappers require a custom command in Agent settings.';
  return undefined;
}

export function addAcpPreset(value: unknown, presetId: string, command: string): unknown[] | Record<string, unknown> {
  const preset = acpPresets.find((preset) => preset.id === presetId);
  if (!preset) throw new Error('Unknown ACP preset.');
  const current = parseAcpProfiles(value);
  if (current.some((profile) => profile.id === preset.id)) return value as unknown[] | Record<string, unknown>;
  // Preserve the user's original objects, including omitted defaults and custom fields.
  const profile = { label: preset.label, command, args: [...preset.args] };
  const next = Array.isArray(value) ? [...value, { id: preset.id, ...profile }] : { ...(value as Record<string, unknown> | undefined), [preset.id]: profile };
  parseAcpProfiles(next);
  return next;
}

/** Executable profiles come only from user settings, never from conversation content. */
export function parseAcpProfiles(value: unknown): AcpProfile[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object') throw new Error('warden.acpAgents must be an object of named agents or a legacy profile array.');
  const legacy = Array.isArray(value);
  const entries: [string | undefined, unknown][] = legacy ? value.map((entry) => [undefined, entry]) : Object.entries(value);
  if (entries.length > 40) throw new Error('warden.acpAgents must contain no more than 40 profiles.');
  const ids = new Set<string>();
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !v.includes('\0');
  return entries.map(([name, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid agent profile.');
    const p = entry as Record<string, unknown>;
    if (!legacy) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Agent names appear in UI and diagnostic logs.
      if (!name?.trim() || name.length > 100 || /[\x00-\x1f\x7f]/.test(name))
        throw new Error('Agent names must be nonempty, at most 100 characters and contain no control characters.');
      const unsupported = Object.keys(p).filter((key) => !['label', 'command', 'args', 'env', 'type'].includes(key));
      if (unsupported.length)
        throw new Error(`Unsupported agent settings: ${unsupported.join(', ')}. Use command, args and env; client-specific options are not supported.`);
      if (p.type !== undefined && p.type !== 'custom') throw new Error('Only custom stdio ACP agents are supported.');
    }
    const id = name ?? p.id;
    const label = legacy || p.label !== undefined ? p.label : name;
    if (!text(id, 100) || (legacy && !/^[a-zA-Z0-9_-]+$/.test(id as string)) || ids.has(id as string))
      throw new Error('Agent IDs must be unique and contain only letters, numbers, underscores and hyphens.');
    if (!text(label, 200) || !(label as string).trim() || !text(p.command, 4000) || !(p.command as string).trim())
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
    ids.add(id as string);
    return {
      id: id as string,
      label: label as string,
      command: p.command as string,
      args: (p.args as string[] | undefined) ?? [],
      ...(p.env === undefined ? {} : { env: p.env as Record<string, string> }),
    };
  });
}
