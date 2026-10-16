import { create } from 'zustand';

export type WorkbenchView = 'preview' | 'history' | 'task';

interface WorkbenchStore {
  view: WorkbenchView;
  taskId: string | null;
  sheet: 'plan' | 'settings' | 'sync' | null;
  navigationOpen: boolean;
  prompts: Record<string, string>;
  openView(view: WorkbenchView): void;
  openTask(id: string): void;
  setSheet(sheet: WorkbenchStore['sheet']): void;
  setPrompt(id: string, text: string): void;
}

export const useWorkbench = create<WorkbenchStore>((set) => ({
  view: 'preview',
  taskId: null,
  sheet: null,
  navigationOpen: false,
  prompts: {},
  openView: (view) => set({ view, navigationOpen: false }),
  openTask: (taskId) => set({ view: 'task', taskId, navigationOpen: false }),
  setSheet: (sheet) => set({ sheet, navigationOpen: false }),
  setPrompt: (id, text) => set((state) => ({ prompts: { ...state.prompts, [id]: text } })),
}));
