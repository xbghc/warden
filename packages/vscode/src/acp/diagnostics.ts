import { redactDiagnostic } from '@warden/shared';
import type { AcpProfile } from './contracts.js';

const sensitiveKey = /authorization|cookie|token|api.?key|secret|password|credential/i;
const privatePayload = /^(?:env|args|command|prompt|messages|content|rawInput|rawOutput)$/i;
const limit = (value: string, size = 8_000) => (value.length > size ? `${value.slice(0, size)}\n[Truncated]` : value);

export const redactAcpDiagnostic = redactDiagnostic;

export function acpDiagnosticSecrets(profile?: AcpProfile): string[] {
  return [
    ...Object.entries(process.env)
      .filter(([key, value]) => value && sensitiveKey.test(key))
      .map(([, value]) => value!),
    ...Object.values(profile?.env ?? {}),
  ].sort((a, b) => b.length - a.length);
}

/** Keep whole stderr lines so truncation cannot expose the tail of a split credential. */
export class AcpStderr {
  text = '';
  private discarding = false;

  append(chunk: string) {
    if (this.discarding) {
      const newline = chunk.indexOf('\n');
      if (newline < 0) return;
      chunk = chunk.slice(newline + 1);
      this.discarding = false;
    }
    const combined = this.text + chunk;
    if (combined.length <= 8_192) {
      this.text = combined;
      return;
    }
    const newline = combined.indexOf('\n', combined.length - 8_192 + 32);
    this.discarding = newline < 0;
    this.text = '[Earlier stderr omitted]\n' + (newline < 0 ? '' : combined.slice(newline + 1));
  }
}

function details(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return limit(redactAcpDiagnostic(value, secrets));
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 4) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => details(item, secrets, depth + 1));
  if (typeof value !== 'object') return String(value);
  const source = value instanceof Error ? { message: value.message, cause: value.cause } : value;
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, 30)
      .map(([key, item]) => [key, sensitiveKey.test(key) || privatePayload.test(key) ? '[Redacted]' : details(item, secrets, depth + 1)]),
  );
}

export function acpErrorDiagnostic(error: unknown, secrets: readonly string[] = []): string {
  const object = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const description = error instanceof Error ? error.message : typeof object?.message === 'string' ? object.message : String(error);
  const code = typeof object?.code === 'number' || typeof object?.code === 'string' ? ` (${object.code})` : '';
  const extra = object?.data ?? object?.cause;
  const detail = extra === undefined ? undefined : details(extra, secrets);
  return limit(
    [redactAcpDiagnostic(description + code, secrets), typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)].filter(Boolean).join('\n'),
    12_000,
  );
}

export function acpErrorMessage(error: unknown): string {
  return limit(acpErrorDiagnostic(error), 2_000);
}

export function acpFailureLog(stage: string, error: unknown, context: { taskId: string; profileId?: string; stderr?: string; secrets?: string[] }): string {
  return [
    `[ACP Task Chat] ${new Date().toISOString()} ${stage} failed; task=${context.taskId}${context.profileId ? `; profile=${context.profileId}` : ''}`,
    acpErrorDiagnostic(error, context.secrets),
    context.stderr ? `Agent stderr:\n${limit(redactAcpDiagnostic(context.stderr, context.secrets))}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}
