import { useMemo, useState } from 'react';
import { ActionIcon } from './ActionIcon';
import type { FileEntry } from '@warden/shared';
import { useStore } from '../store';
import { DiffView } from './DiffView';
import { totalDiffLines } from '../lib/rows';

const BIG_FILE_LINES = 5000;

function FileHeader({ entry }: { entry: FileEntry }) {
  const toggleViewed = useStore((s) => s.toggleViewed);
  const openInNvim = useStore((s) => s.openInNvim);
  const nvimReady = useStore((s) => !!s.nvim?.selected);
  return (
    <div className="file-head">
      <span className={`status status-${entry.status}`}>{entry.status}</span>
      <span className="path mono">
        {entry.oldPath ? (
          <>
            <span className="muted">{entry.oldPath}</span> → {entry.path}
          </>
        ) : (
          entry.path
        )}
      </span>
      {entry.oldMode && entry.newMode && (
        <span className="muted mono">
          mode {entry.oldMode} → {entry.newMode}
        </span>
      )}
      <span className="counts">
        <span className="add">+{entry.additions}</span> <span className="del">-{entry.deletions}</span>
      </span>
      {entry.changed && <span className="changed">文件已变化，viewed 已取消</span>}
      <span className="spacer" />
      <button className="link" disabled={!nvimReady} onClick={() => void openInNvim(entry.path, 1)} title="在 nvim 中打开">
        <ActionIcon name="terminal" label="在 nvim 中打开" />
      </button>
      <label className="check">
        <input type="checkbox" checked={entry.viewed} onChange={() => void toggleViewed(entry.path)} />
        <ActionIcon name="checked" label="已查看" />
      </label>
    </div>
  );
}

export function DiffPanel() {
  const activeFile = useStore((s) => s.activeFile);
  const entry = useStore((s) => s.files.find((f) => f.path === s.activeFile));
  const diffState = useStore((s) => (s.activeFile ? s.diffs[s.activeFile] : undefined));
  const filesLoading = useStore((s) => s.filesLoading);
  const files = useStore((s) => s.files);
  const openFile = useStore((s) => s.openFile);
  const [forceBig, setForceBig] = useState<string | null>(null);

  const lineCount = useMemo(() => (diffState?.status === 'ok' ? totalDiffLines(diffState.diff) : 0), [diffState]);

  if (!activeFile || !entry) {
    return (
      <div className="placeholder">
        {filesLoading && files.length === 0 ? (
          <p>加载文件列表…</p>
        ) : files.length === 0 ? (
          <p>当前 Target 没有改动。</p>
        ) : (
          <>
            <p>在左侧选择一个文件查看 diff。</p>
            <p className="muted">
              快捷键：<kbd>j</kbd>/<kbd>k</kbd> 切换文件，<kbd>n</kbd>/<kbd>p</kbd> 切换 hunk，<kbd>r</kbd> 刷新
            </p>
          </>
        )}
      </div>
    );
  }

  let body: JSX.Element;
  if (!diffState || diffState.status === 'loading') body = <div className="placeholder">加载 diff…</div>;
  else if (diffState.status === 'error')
    body = (
      <div className="placeholder error-box">
        {diffState.message}{' '}
        <button className="link" onClick={() => void openFile(activeFile, true)}>
          <ActionIcon name="refresh" label="重试" />
        </button>
      </div>
    );
  else if (diffState.diff.binary) body = <div className="placeholder">二进制文件，不展示 diff</div>;
  else if (diffState.diff.hunks.length === 0)
    body = (
      <div className="placeholder">
        {entry.oldMode && entry.newMode ? `仅文件模式变更：${entry.oldMode} → ${entry.newMode}` : entry.status === 'renamed' ? '仅重命名，内容无变化' : '空文件 / 无内容变化'}
      </div>
    );
  else if (lineCount > BIG_FILE_LINES && forceBig !== activeFile)
    body = (
      <div className="placeholder">
        <p>该文件 diff 有 {lineCount} 行，默认不渲染。</p>
        <button className="primary" onClick={() => setForceBig(activeFile)}>
          <ActionIcon name="expand" label="仍然渲染" />
        </button>
      </div>
    );
  else body = <DiffView key={activeFile + ':' + diffState.diff.contentHash} diff={diffState.diff} />;

  return (
    <div className="diff-panel">
      <FileHeader entry={entry} />
      {body}
    </div>
  );
}
