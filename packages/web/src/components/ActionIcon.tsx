import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCheck, Circle, CircleCheck,
  CircleDot, Columns2, Copy, FileCode2, Files, Filter, GitBranch, GitCompareArrows,
  History, ListTodo, LoaderCircle, Maximize2, MessageSquare, Pencil, Plus, RefreshCw,
  Save, Search, SquareTerminal, Trash2, Unlink, X, Zap,
} from 'lucide-react';

const icons = {
  down: ArrowDown, back: ArrowLeft, forward: ArrowRight, up: ArrowUp,
  check: Check, checked: CheckCheck, open: Circle, done: CircleCheck, issue: CircleDot,
  split: Columns2, copy: Copy, file: FileCode2, files: Files, filter: Filter,
  branch: GitBranch, compare: GitCompareArrows, history: History, todos: ListTodo,
  loading: LoaderCircle, expand: Maximize2, comments: MessageSquare, edit: Pencil,
  add: Plus, refresh: RefreshCw, save: Save, search: Search, terminal: SquareTerminal,
  delete: Trash2, unlink: Unlink, close: X, auto: Zap,
};
export type ActionIconName = keyof typeof icons;

/** Keep the visible action compact while preserving its accessible name and tooltip. */
export function ActionIcon({ name, label, count }: { name: ActionIconName; label: string; count?: number }) {
  const Icon = icons[name];
  return (
    <span className="action-icon" title={label}>
      <Icon size={16} strokeWidth={1.6} aria-hidden="true" className={name === 'loading' ? 'icon-spinning' : undefined} />
      <span className="sr-only">{label}</span>
      {count !== undefined && count > 0 && <span className="action-count" aria-hidden="true">{count}</span>}
    </span>
  );
}
