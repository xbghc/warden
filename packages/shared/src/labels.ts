import type { PreviewResponse, RebaseBatchResponse, RebaseCheck } from './types.js';

// Identical protocol values have different meanings in previews, forecasts and execution results.
// Keep these operation-specific labels aligned with docs/terminology.md across host and webviews.
export const previewStatusLabels = {
  pending: 'Out of Date',
  updating: 'Syncing',
  synced: 'Synced',
  conflict: 'Preview Conflict',
  error: 'Sync Failed',
  disconnected: 'Primary Only',
  current: 'Synced',
  stale: 'Out of Date',
  paused: 'Migration Required',
} satisfies Record<PreviewResponse['status'] | NonNullable<PreviewResponse['syncStatus']>, string>;

export const rebaseCheckLabels = {
  current: 'Up to Date',
  ready: 'Can Rebase',
  conflict: 'Conflicts Expected',
  blocked: 'Blocked',
  unknown: 'Unknown',
} satisfies Record<RebaseCheck['status'], string>;

export const rebaseResultLabels = {
  updated: 'Rebased',
  skipped: 'Skipped',
  failed: 'Failed',
} satisfies Record<RebaseBatchResponse['results'][number]['status'], string>;

export const scriptStatusLabels = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
} satisfies Record<NonNullable<PreviewResponse['setup']>['status'], string>;
