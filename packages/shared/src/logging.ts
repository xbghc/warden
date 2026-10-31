export type DiagnosticLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type DiagnosticOutcome = 'ok' | 'error' | 'timeout' | 'cancelled' | 'authentication_required';

const privateKey = /authorization|cookie|token|api.?key|secret|password|credential|^(?:env|args|command|prompt|messages|content|rawInput|rawOutput)$/i;

export function redactDiagnostic(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of secrets) {
    // Short environment flags such as "1" must not corrupt timestamps and correlation IDs.
    // Named credential fields and authorization formats are redacted separately below.
    if (secret.length < 4) continue;
    for (const encoded of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) result = result.replaceAll(encoded, '[Redacted]');
  }
  return result
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[Redacted authorization]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[Redacted token]')
    .replace(
      /((?:authorization|cookie|access_token|refresh_token|id_token|api[_-]?key|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[Redacted]',
    )
    .replace(/([?&](?:code|token|access_token|refresh_token|api_key|key|state)=)[^\s&#"']+/gi, '$1[Redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[Redacted]@');
}

/** Keep arbitrary error payloads out of routine operation records. */
export function diagnosticError(error: unknown): DiagnosticFields {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    code: typeof value?.code === 'number' || typeof value?.code === 'string' ? value.code : undefined,
  };
}

export function diagnosticOutcome(error: unknown): DiagnosticOutcome {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return diagnosticError(error).code === -32000 ? 'authentication_required' : 'error';
}

/** A host-supplied, local sink. Callers select metadata explicitly instead of serializing requests. */
export class DiagnosticLog {
  constructor(
    private readonly sink?: (level: DiagnosticLevel, line: string) => void,
    private readonly context: DiagnosticFields = {},
    private readonly secrets: readonly string[] = [],
    private readonly sequence = { next: 0 },
  ) {}

  child(context: DiagnosticFields, secrets: readonly string[] = []): DiagnosticLog {
    return new DiagnosticLog(this.sink, { ...this.context, ...context }, [...this.secrets, ...secrets], this.sequence);
  }

  write(level: DiagnosticLevel, event: string, fields: DiagnosticFields = {}) {
    if (!this.sink) return;
    try {
      const record = Object.fromEntries(
        Object.entries({ ...this.context, ...fields, timestamp: new Date().toISOString(), event }).map(([key, value]) => [
          key,
          privateKey.test(key)
            ? '[Redacted]'
            : typeof value === 'string'
              ? redactDiagnostic(value, this.secrets).slice(0, key === 'diagnostic' ? 16_000 : 1_000)
              : value,
        ]),
      );
      this.sink(level, `[diagnostic] ${JSON.stringify(record)}`);
    } catch {
      // Diagnostics must not affect operations, including shutdown after the sink is disposed.
    }
  }

  start(event: string, fields: DiagnosticFields = {}, level: DiagnosticLevel = 'debug') {
    const log = this.child({ ...fields, operation: ++this.sequence.next });
    const started = performance.now();
    let finished = false;
    log.write(level, `${event}.start`);
    return {
      end(outcome: DiagnosticOutcome = 'ok', details: DiagnosticFields = {}) {
        if (finished) return;
        finished = true;
        const severity = outcome === 'error' || outcome === 'timeout' ? 'error' : outcome === 'authentication_required' ? 'warn' : level;
        log.write(severity, `${event}.end`, { ...details, outcome, durationMs: Math.round(Math.max(0, performance.now() - started)) });
      },
    };
  }

  async measure<T>(event: string, operation: () => T | Promise<T>, fields: DiagnosticFields = {}, level: DiagnosticLevel = 'debug'): Promise<T> {
    const span = this.start(event, fields, level);
    try {
      const result = await operation();
      span.end();
      return result;
    } catch (error) {
      span.end(diagnosticOutcome(error), diagnosticError(error));
      throw error;
    }
  }
}
