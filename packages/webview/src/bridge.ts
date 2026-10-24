import type { WorkbenchAction, WorkbenchModel } from '@warden/shared';

interface Host {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): Host;
const host = acquireVsCodeApi();
let sequence = 0;
export const bridge = {
  ready: () => host.postMessage({ type: 'ready' }),
  action: (model: WorkbenchModel, action: WorkbenchAction) => host.postMessage({ type: 'action', requestId: ++sequence, session: model.session, action }),
  read: <T>(key: string, fallback: T): T => (host.getState() as Record<string, T> | undefined)?.[key] ?? fallback,
  save: (key: string, value: unknown) => host.setState({ ...((host.getState() as object) ?? {}), [key]: value }),
};
