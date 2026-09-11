import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { ActionIcon } from './ActionIcon';

export function NvimSelector() {
  const containerRef = useRef<HTMLDetailsElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const positionPopover = () => {
    const container = containerRef.current;
    const popover = popoverRef.current;
    if (!container?.open || !popover) return;
    const anchor = container.getBoundingClientRect();
    const width = popover.getBoundingClientRect().width;
    const viewportWidth = container.ownerDocument.documentElement.clientWidth;
    const left = Math.max(16, Math.min(anchor.right - width, viewportWidth - width - 16));
    popover.style.left = `${left - anchor.left}px`;
  };
  useEffect(() => {
    const observer = new ResizeObserver(positionPopover);
    if (containerRef.current) observer.observe(containerRef.current);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener('resize', positionPopover);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', positionPopover);
    };
  }, []);
  const nvim = useStore((s) => s.nvim);
  const scanning = useStore((s) => s.nvimScanning);
  const scan = useStore((s) => s.scanNvim);
  const select = useStore((s) => s.selectNvim);

  const instances = nvim?.instances ?? [];
  let content: JSX.Element;
  if (!nvim) content = <span className="muted">nvim: 未扫描</span>;
  else if (!nvim.nvimAvailable) content = <span className="muted">nvim 不可用：PATH 中找不到可执行文件</span>;
  else if (instances.length === 0) content = <span className="muted">未发现在此仓库打开的 nvim</span>;
  else if (instances.length === 1) {
    const i = instances[0]!;
    content = (
      <span className="nvim-one" title={`${i.socket}\ncwd: ${i.cwd}`}>
        nvim{i.pid ? ` #${i.pid}` : ''} — {i.cwd}
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
    <details ref={containerRef} className="nvim" onToggle={positionPopover} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
    }} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}>
      <summary aria-label="nvim 设置"><ActionIcon name="terminal" label="nvim 设置" /></summary>
      <div ref={popoverRef} className="nvim-popover">
      {content}
      <button className="icon" onClick={() => void scan(true)} disabled={scanning} title="重新扫描 nvim 实例">
        <ActionIcon name={scanning ? 'loading' : 'refresh'} label="重新扫描 nvim 实例" />
      </button>
      </div>
    </details>
  );
}
