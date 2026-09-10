import { useStore } from '../store';

/**
 * Jump-to-nvim lives in the top bar, so it is priced by the width it takes there. Its idle states
 * — nvim missing from PATH, or running but not in this repository — used to spend a full sentence
 * saying nothing actionable; they are now the rescan button alone, with the state in its tooltip.
 */
export function NvimSelector() {
  const nvim = useStore((s) => s.nvim);
  const scanning = useStore((s) => s.nvimScanning);
  const scan = useStore((s) => s.scanNvim);
  const select = useStore((s) => s.selectNvim);

  const instances = nvim?.instances ?? [];
  // Nothing to jump into and nothing a rescan would find: the whole control goes away.
  if (nvim && !nvim.nvimAvailable) return null;

  let content: JSX.Element | null = null;
  let hint = '扫描此仓库中打开的 nvim';
  if (!nvim) hint = '还未扫描 nvim';
  else if (instances.length === 0) hint = '此仓库没有打开的 nvim；启动一个后点这里重新扫描';
  else if (instances.length === 1) {
    const i = instances[0]!;
    hint = `${i.socket}\ncwd: ${i.cwd}\n重新扫描`;
    content = <span className="nvim-one">nvim{i.pid ? ` #${i.pid}` : ''}</span>;
  } else {
    content = (
      <select value={nvim.selected ?? ''} onChange={(e) => void select(e.target.value)} title="多个 nvim 实例，请选择跳转目标" aria-label="nvim 实例">
        {!nvim.selected && <option value="">选择 nvim…</option>}
        {instances.map((i) => (
          <option key={i.socket} value={i.socket}>
            nvim{i.pid ? ` #${i.pid}` : ''} — {i.cwd}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="nvim">
      {content}
      <button className="quiet" onClick={() => void scan(true)} disabled={scanning} title={hint} aria-label="重新扫描 nvim 实例">
        {/* Named when there is nothing beside it to name it: a lone ⟳ in a toolbar says nothing
            about what it would rescan. */}
        {content ? null : <span className="nvim-idle">nvim</span>}
        {scanning ? '…' : '⟳'}
      </button>
    </div>
  );
}
