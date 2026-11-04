import type { AgentAuthMethod, AgentConfiguration, AgentIdentity, AgentReadiness } from './agent.js';
import { parseFileReference } from './file-reference.js';

/** ACP UI data contains no executable configuration or provider credentials. */
export interface AcpBinding {
  repository: string;
  taskId: string;
  title: string;
  workspace: string;
  branch: string;
  identity: string;
}

export type AcpProfileSummary = AgentIdentity;
export type AcpConfiguration = AgentConfiguration;
export type AcpReadiness = AgentReadiness;

export type AcpStatus = 'disconnected' | 'connecting' | 'connected' | 'running' | 'waiting_permission' | 'cancelling' | 'resetting' | 'error';
export interface AcpMessage {
  id: string;
  role: 'user' | 'agent' | 'thought' | 'tool' | 'notice';
  text: string;
  status?: string;
  /** Agent-reported command result, independent of its reported tool status. */
  exitCode?: number;
  exitSignal?: string;
  toolCallId?: string;
  compactionId?: string;
  compaction?: { summary?: string; error?: string };
  uncertain?: boolean;
}
export interface AcpPermission {
  id: string;
  title: string;
  detail: string;
  command?: string;
  cwd?: string;
  reason?: string;
  options: { id: string; label: string; kind: string }[];
}
export type AcpAuthMethod = AgentAuthMethod;
export type AcpConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: string;
} & (
  | { type: 'boolean'; currentValue: boolean }
  | {
      type: 'select';
      currentValue: string;
      options: { value: string; name: string; description?: string; group?: string }[];
    }
);
/** Agent-provided controls are live connection state, never executable configuration. */
export interface AcpControls {
  configOptions?: AcpConfigOption[];
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] };
  commands: { name: string; description: string; inputHint?: string }[];
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  title?: string;
  configuring: boolean;
  notices: { id: string; title: string; description?: string; severity: string }[];
}
export interface AcpModelSelection {
  configId: string;
  value: string;
}
export interface AcpRecord {
  schemaVersion: 1;
  id: string;
  binding: AcpBinding;
  profileId?: string;
  profileSignature?: string;
  sessionId?: string;
  agentName?: string;
  modelSelection?: AcpModelSelection;
  canLoad: boolean;
  messages: AcpMessage[];
  updatedAt: string;
  interrupted?: boolean;
}
export interface AcpSnapshot {
  record: AcpRecord;
  status: AcpStatus;
  error?: string;
  permissions: AcpPermission[];
  /** Offered recovery methods, exposed only after the agent requests authentication. */
  authMethods: AcpAuthMethod[];
  controls?: AcpControls;
}
export type AcpDraftChange = { version: number; type: 'append'; text: string } | { version: number; type: 'clear'; revision: number };
export interface AcpDraftEdit {
  text: string;
  /** Last host append/clear applied by this panel. */
  version: number;
  /** Monotonic local edit revision within this panel. */
  revision: number;
}
export interface AcpViewState {
  scrollTop: number;
  followOutput: boolean;
  profileId: string;
}
export interface AcpModel extends AcpSnapshot {
  /** Panel identity, independent of the currently selected workbench repository. */
  panelId: string;
  profiles: AcpProfileSummary[];
  /** New conversations use the agent verified in workbench setup. */
  defaultProfileId?: string;
  /** A send remains active until the completed transcript and draft acknowledgement are settled. */
  sending: boolean;
  /** The accepted draft remains durable while the composer is available for a follow-up. */
  submittedDraft?: { version: number; revision: number };
  draft: string;
  draftVersion: number;
  draftRevision: number;
  draftChanges: AcpDraftChange[];
  presentation?: 'sidebar' | 'editor';
  viewState?: AcpViewState;
}
export type AcpAction =
  | ({ type: 'send'; profileId: string } & AcpDraftEdit)
  | { type: 'connect'; profileId: string; resume: boolean }
  | { type: 'cancel' | 'disconnect' | 'new' | 'configure' | 'review' | 'open-sidebar' | 'view-ready' | 'insert-brief' }
  | ({ type: 'view-state'; requestId?: string } & AcpViewState)
  | ({ type: 'draft' } & AcpDraftEdit)
  | { type: 'permission'; requestId: string; optionId: string }
  | { type: 'authenticate'; methodId: string }
  | { type: 'set-config'; configId: string; value: string | boolean }
  | { type: 'set-mode'; modeId: string }
  | { type: 'open-file'; reference: string };

export function parseAcpAction(value: unknown): AcpAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation action.');
  const action = value as Record<string, unknown>;
  const text = (key: string, max = 100_000) => {
    const v = action[key];
    if (typeof v !== 'string' || v.length > max) throw new Error('Invalid conversation parameters.');
    return v;
  };
  const id = (key: string) => {
    const v = text(key, 500);
    if (!v) throw new Error('Conversation ID cannot be empty.');
    return v;
  };
  const sequence = (key: string) => {
    const value = action[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid draft version.');
    return value;
  };
  const draft = (): AcpDraftEdit => ({ text: text('text'), version: sequence('version'), revision: sequence('revision') });
  switch (action.type) {
    case 'send':
      return { type: 'send', ...draft(), profileId: id('profileId') };
    case 'connect':
      if (typeof action.resume !== 'boolean') throw new Error('Invalid session resume option.');
      return { type: 'connect', profileId: id('profileId'), resume: action.resume };
    case 'cancel':
    case 'disconnect':
    case 'new':
    case 'configure':
    case 'review':
    case 'open-sidebar':
    case 'view-ready':
    case 'insert-brief':
      return { type: action.type };
    case 'view-state':
      if (
        typeof action.scrollTop !== 'number' ||
        !Number.isFinite(action.scrollTop) ||
        action.scrollTop < 0 ||
        action.scrollTop > 1e9 ||
        typeof action.followOutput !== 'boolean'
      )
        throw new Error('Invalid conversation view state.');
      return {
        type: 'view-state',
        scrollTop: action.scrollTop,
        followOutput: action.followOutput,
        profileId: text('profileId', 500),
        ...(action.requestId === undefined ? {} : { requestId: id('requestId') }),
      };
    case 'draft':
      return { type: 'draft', ...draft() };
    case 'permission':
      return { type: 'permission', requestId: id('requestId'), optionId: id('optionId') };
    case 'authenticate':
      return { type: 'authenticate', methodId: id('methodId') };
    case 'set-config': {
      const value = typeof action.value === 'boolean' ? action.value : id('value');
      return { type: 'set-config', configId: id('configId'), value };
    }
    case 'set-mode':
      return { type: 'set-mode', modeId: id('modeId') };
    case 'open-file': {
      const reference = text('reference', 16000);
      if (!parseFileReference(reference)) throw new Error('Invalid workspace file reference.');
      return { type: 'open-file', reference };
    }
    default:
      throw new Error('Unknown conversation action.');
  }
}
