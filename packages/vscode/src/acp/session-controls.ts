import type { AcpConfigOption, AcpControls } from '@warden/shared';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown, limit = 1_000) => (typeof value === 'string' ? value.slice(0, limit) : undefined);
const identifier = (value: unknown) => (typeof value === 'string' && value && value.length <= 500 ? value : undefined);
const description = (value: unknown) => (typeof value === 'string' ? { description: value.slice(0, 4_000) } : {});

export function emptyControls(): AcpControls {
  return { commands: [], configuring: false, notices: [] };
}

/** Keep agent-provided choices bounded and display-only before exposing them to a webview. */
export function configOptions(value: unknown): AcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  const result: AcpConfigOption[] = [];
  const ids = new Set<string>();
  for (const entry of value.slice(0, 100)) {
    if (!object(entry)) continue;
    const id = identifier(entry.id);
    const name = label(entry.name);
    if (!id || name === undefined || ids.has(id)) continue;
    const base = { id, name, ...description(entry.description), ...(typeof entry.category === 'string' ? { category: entry.category.slice(0, 500) } : {}) };
    if (entry.type === 'boolean' && typeof entry.currentValue === 'boolean') {
      result.push({ ...base, type: 'boolean', currentValue: entry.currentValue });
    } else if (entry.type === 'select' && typeof entry.currentValue === 'string' && entry.currentValue.length <= 500 && Array.isArray(entry.options)) {
      const options: Extract<AcpConfigOption, { type: 'select' }>['options'] = [];
      const values = new Set<string>();
      const add = (value: unknown, group?: string) => {
        if (!object(value) || options.length >= 200) return;
        const optionValue = identifier(value.value);
        const optionName = label(value.name);
        if (!optionValue || optionName === undefined || values.has(optionValue)) return;
        options.push({ value: optionValue, name: optionName, ...description(value.description), ...(group === undefined ? {} : { group }) });
        values.add(optionValue);
      };
      for (const option of entry.options.slice(0, 200)) {
        if (object(option) && Array.isArray(option.options) && typeof option.name === 'string') {
          for (const item of option.options.slice(0, 200)) add(item, label(option.name));
        } else add(option);
      }
      result.push({ ...base, type: 'select', currentValue: entry.currentValue, options });
    } else continue;
    ids.add(id);
  }
  return result;
}

export function sessionModes(value: unknown): AcpControls['modes'] {
  if (!object(value) || !identifier(value.currentModeId) || !Array.isArray(value.availableModes)) return;
  const availableModes: NonNullable<AcpControls['modes']>['availableModes'] = [];
  const ids = new Set<string>();
  for (const mode of value.availableModes.slice(0, 100)) {
    if (!object(mode)) continue;
    const id = identifier(mode.id);
    const name = label(mode.name);
    if (!id || name === undefined || ids.has(id)) continue;
    ids.add(id);
    availableModes.push({ id, name, ...description(mode.description) });
  }
  return { currentModeId: value.currentModeId as string, availableModes };
}

export function availableCommands(value: unknown): AcpControls['commands'] {
  if (!Array.isArray(value)) return [];
  const commands: AcpControls['commands'] = [];
  const names = new Set<string>();
  for (const command of value.slice(0, 100)) {
    if (!object(command)) continue;
    const name = identifier(command.name);
    const commandDescription = label(command.description, 4_000);
    if (!name || commandDescription === undefined || names.has(name)) continue;
    names.add(name);
    commands.push({
      name,
      description: commandDescription,
      ...(object(command.input) && typeof command.input.hint === 'string' ? { inputHint: command.input.hint.slice(0, 1_000) } : {}),
    });
  }
  return commands;
}
