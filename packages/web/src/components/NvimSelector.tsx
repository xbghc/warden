import { useStore } from '../store';

export function NvimSelector() {
  const nvim = useStore((s) => s.nvim);
  const scanning = useStore((s) => s.nvimScanning);
  const scan = useStore((s) => s.scanNvim);
  const select = useStore((s) => s.selectNvim);

  const instances = nvim?.instances ?? [];
  let content: JSX.Element;
  if (!nvim) content = <span className="muted">nvim: 未扫描</span>;
  else if (!nvim.nvimAvailable) content = <span className="muted" title="PATH 中找不到 nvim 可执行文件">nvim 不可用</span>;
  else if (instances.length === 0) content = <span className="muted">未发现在此仓库打开的 nvim</span>;
  else if (instances.length === 1) {
    const i = instances[0]!;
    content = (
      <span className="nvim-one" title={`${i.socket}\ncwd: ${i.cwd}`}>
        nvim{i.pid ? ` #${i.pid}` : ''}
      </span>
    );
  } else {
    content = (
      <select value={nvim.selected ?? ''} onChange={(e) => void select(e.target.value)} title="多个 nvim 实例，请选择跳转目标">
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
      <button className="icon" onClick={() => void scan(true)} disabled={scanning} title="重新扫描 nvim 实例">
        {scanning ? '…' : '⟳'}
      </button>
    </div>
  );
}
