import { useStore } from '../store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  const action = toast.action;
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      {toast.message}
      {action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            useStore.setState({ toast: null });
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
