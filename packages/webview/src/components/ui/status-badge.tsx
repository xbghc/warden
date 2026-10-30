import type { ReactNode } from 'react';

export function StatusBadge({ status, children }: { status?: string; children: ReactNode }) {
  const tone = ['conflict', 'error', 'failed'].includes(status ?? '')
    ? 'error'
    : ['synced', 'current', 'succeeded', 'updated', 'connected'].includes(status ?? '')
      ? 'success'
      : ['pending', 'stale', 'paused', 'blocked', 'waiting_permission', 'uncertain'].includes(status ?? '')
        ? 'warning'
        : 'neutral';
  return <span className={`status-badge status-badge-${tone}`}>{children}</span>;
}
