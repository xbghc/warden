import { create } from 'zustand';
import type { PreviewResponse, RebaseCheck, HistoryResponse } from '@warden/shared';
import { api } from './api';
import { useWorkflow } from './workflow-store';

interface WorkbenchData {
  preview: PreviewResponse | null;
  checks: RebaseCheck[];
  history: HistoryResponse | null;
  errors: { preview?: string; checks?: string; history?: string };
  checking: boolean;
  refresh(): Promise<void>;
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

let refreshRun: Promise<void> | null = null;
let refreshPending = false;
export const useWorkbenchData = create<WorkbenchData>((set, get) => ({
  preview: null,
  checks: [],
  history: null,
  errors: {},
  checking: false,
  refresh() {
    if (refreshRun) {
      refreshPending = true;
      return refreshRun;
    }
    set({ checking: true });
    refreshRun = (async () => {
      do {
        refreshPending = false;
        const branch = useWorkflow.getState().data?.workflow?.developmentBranch;
        if (get().history?.branch !== branch) set({ history: null, checks: [] });
        if (get().preview?.developmentBranch !== branch) set({ preview: null });
        const snapshot = get();
        const [preview, checks, history] = await Promise.allSettled([
          api.preview(),
          branch ? api.rebaseChecks() : Promise.resolve({ checks: [] }),
          branch ? api.history() : Promise.resolve(null),
        ]);
        // A context change or a mutation completed while read-only checks were running.
        // Keep the newer result and perform a fresh pass after the outstanding reads.
        if (branch !== useWorkflow.getState().data?.workflow?.developmentBranch) {
          refreshPending = true;
          continue;
        }
        set((state) => ({
          preview: state.preview !== snapshot.preview ? state.preview : preview.status === 'fulfilled' ? preview.value : state.preview,
          checks: checks.status === 'fulfilled' ? checks.value.checks : state.checks,
          history: state.history !== snapshot.history ? state.history : history.status === 'fulfilled' ? history.value : state.history,
          errors: {
            ...(preview.status === 'rejected' && state.preview === snapshot.preview ? { preview: errorMessage(preview.reason) } : {}),
            ...(checks.status === 'rejected' ? { checks: errorMessage(checks.reason) } : {}),
            ...(history.status === 'rejected' && state.history === snapshot.history ? { history: errorMessage(history.reason) } : {}),
          },
        }));
      } while (refreshPending);
    })().finally(() => {
      refreshRun = null;
      set({ checking: false });
    });
    return refreshRun;
  },
}));
