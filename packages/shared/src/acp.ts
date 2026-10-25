/** ACP UI data contains no executable configuration or provider credentials. */
export interface AcpBinding {
  repository: string;
  taskId: string;
  title: string;
  workspace: string;
  branch: string;
  identity: string;
}

export interface AcpProfileSummary {
  id: string;
  label: string;
}

export type AcpStatus = 'disconnected' | 'connecting' | 'connected' | 'running' | 'waiting_permission' | 'cancelling' | 'error';
export interface AcpMessage {
  id: string;
  role: 'user' | 'agent' | 'tool' | 'notice';
  text: string;
  status?: string;
  toolCallId?: string;
  uncertain?: boolean;
}
export interface AcpPermission {
  id: string;
  title: string;
  detail: string;
  options: { id: string; label: string; kind: string }[];
}
export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
}
export interface AcpRecord {
  schemaVersion: 1;
  id: string;
  binding: AcpBinding;
  profileId?: string;
  profileSignature?: string;
  sessionId?: string;
  agentName?: string;
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
  authMethods: AcpAuthMethod[];
}
export type AcpDraftChange = { version: number; type: 'append'; text: string } | { version: number; type: 'clear'; revision: number };
export interface AcpDraftEdit {
  text: string;
  /** Last host append/clear applied by this panel. */
  version: number;
  /** Monotonic local edit revision within this panel. */
  revision: number;
}
export interface AcpModel extends AcpSnapshot {
  /** Panel identity, independent of the currently selected workbench repository. */
  panelId: string;
  profiles: AcpProfileSummary[];
  draft: string;
  draftVersion: number;
  draftRevision: number;
  draftChanges: AcpDraftChange[];
}
export type AcpAction =
  | ({ type: 'send'; profileId: string } & AcpDraftEdit)
  | { type: 'connect'; profileId: string; resume: boolean }
  | { type: 'cancel' | 'disconnect' | 'new' | 'configure' | 'review' }
  | ({ type: 'draft' } & AcpDraftEdit)
  | { type: 'permission'; requestId: string; optionId: string }
  | { type: 'authenticate'; methodId: string };

export function parseAcpAction(value: unknown): AcpAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('对话操作格式错误');
  const action = value as Record<string, unknown>;
  const text = (key: string, max = 100_000) => {
    const v = action[key];
    if (typeof v !== 'string' || v.length > max) throw new Error('对话参数格式错误');
    return v;
  };
  const id = (key: string) => {
    const v = text(key, 500);
    if (!v) throw new Error('对话标识不能为空');
    return v;
  };
  const sequence = (key: string) => {
    const value = action[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('草稿版本无效');
    return value;
  };
  const draft = (): AcpDraftEdit => ({ text: text('text'), version: sequence('version'), revision: sequence('revision') });
  switch (action.type) {
    case 'send':
      return { type: 'send', ...draft(), profileId: id('profileId') };
    case 'connect':
      if (typeof action.resume !== 'boolean') throw new Error('会话恢复选项无效');
      return { type: 'connect', profileId: id('profileId'), resume: action.resume };
    case 'cancel':
    case 'disconnect':
    case 'new':
    case 'configure':
    case 'review':
      return { type: action.type };
    case 'draft':
      return { type: 'draft', ...draft() };
    case 'permission':
      return { type: 'permission', requestId: id('requestId'), optionId: id('optionId') };
    case 'authenticate':
      return { type: 'authenticate', methodId: id('methodId') };
    default:
      throw new Error('未知对话操作');
  }
}
