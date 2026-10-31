import type { AcpBinding, AcpRecord, DiagnosticLog } from '@warden/shared';

export interface AcpProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AcpStorage {
  load(): Promise<AcpRecord | undefined>;
  save(record: AcpRecord): Promise<void>;
  archive(record: AcpRecord): Promise<void>;
  claim(): Promise<() => Promise<void>>;
}

export interface AcpSessionOptions {
  binding: AcpBinding;
  storage: AcpStorage;
  validate(): Promise<void>;
  changed(): void;
  report?(diagnostic: string): void;
  log?: DiagnosticLog;
  connectionFailed?(profile: AcpProfile, message: string): void;
  timeoutMs?: number;
}
