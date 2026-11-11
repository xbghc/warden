import type { AcpBinding, AcpModelSelection, AcpRecord, DiagnosticLog } from '@warden/shared';
import type { EngineOutput } from '@warden/engine';

export interface AcpProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** A live agent process started by this window's Warden. */
export interface AgentProcessInfo {
  pid: number;
  profile: AcpProfile;
  startedAt: string;
}

export interface AcpStorage {
  load(): Promise<AcpRecord | undefined>;
  save(record: AcpRecord): Promise<void>;
  archive(record: AcpRecord): Promise<void>;
  claim(): Promise<() => Promise<void>>;
  claimToken?(): string | undefined;
}

export interface AcpSessionOptions {
  binding: AcpBinding;
  storage: AcpStorage;
  modelPreferences?: {
    load(profileSignature: string): AcpModelSelection | undefined;
    save(profileSignature: string, selection: AcpModelSelection): Promise<void>;
  };
  validate(): Promise<void>;
  readRoots?(): Promise<EngineOutput<'repository.readRoots'>>;
  changed(): void;
  report?(diagnostic: string): void;
  log?: DiagnosticLog;
  connectionFailed?(profile: AcpProfile, message: string): void;
  timeoutMs?: number;
}

/** The SDK's own default. Stored text is truncated separately, so a large tool result or image
 * must not be treated as a broken connection.
 */
export const MAX_ACP_MESSAGE_BYTES = 32 * 1024 * 1024;
