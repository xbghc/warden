import type { AcpModelSelection } from '@warden/shared';
import type { Memento } from 'vscode';

export function modelSelection(value: unknown): AcpModelSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const selection = value as Record<string, unknown>;
  if (Object.keys(selection).some((key) => key !== 'configId' && key !== 'value')) return;
  if ([selection.configId, selection.value].some((item) => typeof item !== 'string' || !item.length || item.length > 500)) return;
  return { configId: selection.configId as string, value: selection.value as string };
}

/** One independent key per profile avoids overwriting preferences saved by another chat. */
export class AcpModelPreferences {
  constructor(private readonly state: Pick<Memento, 'get' | 'update'>) {}

  load(profileSignature: string): AcpModelSelection | undefined {
    return modelSelection(this.state.get(`warden.acpModel:${profileSignature}`));
  }

  async save(profileSignature: string, selection: AcpModelSelection): Promise<void> {
    const valid = modelSelection(selection);
    if (!valid) throw new Error('Invalid model preference.');
    await this.state.update(`warden.acpModel:${profileSignature}`, valid);
  }
}
