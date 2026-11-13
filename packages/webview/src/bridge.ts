import type { AcpAction, AcpModel, WorkbenchAction, WorkbenchModel } from '@warden/shared';

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
  acpAction: (model: AcpModel, action: AcpAction) => host.postMessage({ type: 'acp-action', panelId: model.panelId, action }),
  // VS Code keeps this state while a hidden panel's content is discarded and rebuilt.
  state: () => host.getState(),
  saveState: (state: unknown) => host.setState(state),
};
