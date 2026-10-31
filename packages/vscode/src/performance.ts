import { randomUUID } from 'node:crypto';

export type PerformanceOutcome = 'ok' | 'error' | 'timeout' | 'cancelled' | 'authentication_required';
export type PerformanceStage =
  | 'activation'
  | 'repository.open'
  | 'repository.wait'
  | 'repository.refresh'
  | 'repository.get'
  | 'context.update'
  | 'engine.open'
  | 'engine.start'
  | 'workflow.get'
  | 'workflow.configure'
  | 'workflow.context'
  | 'preview.get'
  | 'workspaces.list'
  | 'rebase.check'
  | 'review.restore'
  | 'acp.connect'
  | 'acp.cleanup'
  | 'acp.spawn'
  | 'acp.initialize'
  | 'acp.session.new'
  | 'acp.authenticate';

export interface PerformanceRecord {
  version: 1;
  run: string;
  span: number;
  parent?: number;
  stage: PerformanceStage;
  event: 'start' | 'end';
  timestamp: string;
  elapsedMs: number;
  durationMs?: number;
  outcome?: PerformanceOutcome;
}

const milliseconds = (value: number) => Math.round(Math.max(0, value) * 100) / 100;

/** Local timings contain only fixed stage names and numeric IDs, never operation inputs or errors. */
export class PerformanceLog {
  private readonly run = randomUUID();
  private sequence = 0;

  constructor(
    private readonly write: (line: string) => void,
    readonly origin = performance.now(),
  ) {}

  start(stage: PerformanceStage, parent?: PerformanceSpan, started = performance.now()): PerformanceSpan {
    const span = ++this.sequence;
    let ended = false;
    const emit = (event: 'start' | 'end', outcome?: PerformanceOutcome) => {
      const now = performance.now();
      const record: PerformanceRecord = {
        version: 1,
        run: this.run,
        span,
        parent: parent?.id,
        stage,
        event,
        timestamp: new Date().toISOString(),
        elapsedMs: milliseconds(now - this.origin),
        ...(event === 'end' ? { durationMs: milliseconds(now - started), outcome } : {}),
      };
      try {
        this.write(`[performance] ${JSON.stringify(record)}`);
      } catch {
        // A disposed output channel must not fail or replace the operation being measured.
      }
    };
    emit('start');
    return new PerformanceSpan(this, span, (outcome) => {
      if (ended) return;
      ended = true;
      emit('end', outcome);
    });
  }

  async measure<T>(
    stage: PerformanceStage,
    operation: (span: PerformanceSpan) => T | Promise<T>,
    parent?: PerformanceSpan,
    failure: (error: unknown) => PerformanceOutcome = () => 'error',
  ): Promise<T> {
    const span = this.start(stage, parent);
    try {
      const result = await operation(span);
      span.end();
      return result;
    } catch (error) {
      span.end(failure(error));
      throw error;
    }
  }
}

export class PerformanceSpan {
  constructor(
    private readonly log: PerformanceLog,
    readonly id: number,
    private readonly finish: (outcome: PerformanceOutcome) => void,
  ) {}

  end(outcome: PerformanceOutcome = 'ok') {
    this.finish(outcome);
  }

  measure<T>(stage: PerformanceStage, operation: (span: PerformanceSpan) => T | Promise<T>, failure?: (error: unknown) => PerformanceOutcome): Promise<T> {
    return this.log.measure(stage, operation, this, failure);
  }
}
