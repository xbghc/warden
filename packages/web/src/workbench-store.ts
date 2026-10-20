import { create } from 'zustand';

export type WorkbenchView = 'preview' | 'history' | 'task';

interface WorkbenchStore {
  view: WorkbenchView;
  taskId: string | null;
  sheet: 'plan' | 'settings' | 'sync' | null;
  navigationOpen: boolean;
  openView(view: WorkbenchView): void;
  openTask(id: string): void;
  setSheet(sheet: WorkbenchStore['sheet']): void;
}

export const useWorkbench = create<WorkbenchStore>((set) => ({
  view: 'preview',
  taskId: null,
  sheet: null,
  navigationOpen: false,
  openView: (view) => set({ view, navigationOpen: false }),
  openTask: (taskId) => set({ view: 'task', taskId, navigationOpen: false }),
  setSheet: (sheet) => set({ sheet, navigationOpen: false }),
}));
