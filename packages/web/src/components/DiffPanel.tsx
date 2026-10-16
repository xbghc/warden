import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { useMemo, useState } from 'react';
import type { FileEntry } from '@warden/shared';
import { useStageMode, useStore, useTracksViewed } from '../store';
import { ActionIcon } from './ActionIcon';
import { DiffView } from './DiffView';
import { STATUS_LETTER } from './FileTree';
import { totalDiffLines } from '../lib/rows';

const BIG_FILE_LINES = 5000;

/** Directory in the quiet colour, basename in the strong one — the name is what you scan for. */
function PathParts({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <>
      {cut > 0 && <span className="dir">{path.slice(0, cut)}</span>}
      <span className="base">{path.slice(cut)}</span>
    </>
  );
}

function FileHeader({ entry }: { entry: FileEntry }) {
  const toggleViewed = useStore((s) => s.toggleViewed);
  const copyToClipboard = useStore((s) => s.copyToClipboard);
  const stageLines = useStore((s) => s.stageLines);
  const staging = useStore((s) => s.staging);
  const mode = useStageMode();
  const marks = useTracksViewed();
  const skipsDebug = useStore((s) => s.prefs.ignoreDebug) && !!entry.debugAdditions;
  return (
    <div className="file-head">
      {entry.conflicted ? (
        <span className="status status-conflicted" title="合并冲突：在终端里解决并 git add；这里显示的是相对 HEAD 的 diff">
          U 冲突
        </span>
      ) : (
        <span className={`status status-${entry.status}`} title={entry.status}>
          {STATUS_LETTER[entry.status]}
        </span>
      )}
      <span className="path">
        {entry.oldPath && (
          <>
            <span className="dir">{entry.oldPath}</span> <span className="muted">→</span>{' '}
          </>
        )}
        <PathParts path={entry.path} />
      </span>
      <Button variant="ghost" size="icon-sm" className="icon quiet copy-path" onClick={() => void copyToClipboard(entry.path)} title={`复制路径 ${entry.path}`}>
        <ActionIcon name="copy" label="复制路径" />
      </Button>
      {entry.oldMode && entry.newMode && (
        <span className="muted mono">
          mode {entry.oldMode} → {entry.newMode}
        </span>
      )}
      <span className="counts">
        <span className="add">+{entry.additions}</span> <span className="del">-{entry.deletions}</span>
      </span>
      {marks && entry.changed && <span className="changed">文件已变化，“已读”标记已取消</span>}
      <span className="spacer" />
      {mode && (
        <Button
          variant="outline"
          size="sm"
          disabled={staging || entry.binary}
          onClick={() => void stageLines(entry.path)}
          title={
            entry.binary
              ? '二进制文件无法从这里暂存，请用 git add / git restore --staged'
              : mode === 'stage'
                ? `把这个文件的全部改动放入暂存区（含模式变更${skipsDebug ? '，跳过调试代码' : ''}）`
                : '把这个文件的全部改动移出暂存区'
          }
        >
          {mode === 'stage' ? '暂存文件' : '取消暂存文件'}
        </Button>
      )}
      {/* Where a file can be staged that is how it is marked done, by the button above; a second
          tick beside it only ever disagreed with the first. */}
      {marks && (
        <label className="check">
          <Checkbox checked={entry.viewed} onCheckedChange={() => void toggleViewed(entry.path)} />
          已读
        </label>
      )}
    </div>
  );
}

/** Floats over the diff while rows are picked: what was picked, and the one thing to do with it. */
function StageBar({ filePath }: { filePath: string }) {
  const sel = useStore((s) => (s.stageSel?.filePath === filePath ? s.stageSel : null));
  const staging = useStore((s) => s.staging);
  const stageSelection = useStore((s) => s.stageSelection);
  const setStageSel = useStore((s) => s.setStageSel);
  const mode = useStageMode();
  if (!sel || !mode) return null;
  const n = sel.lines.length;
  return (
    <div className="stage-bar" role="toolbar" aria-label="暂存所选行">
      <span className="stage-bar-count">
        已选 <b>{n}</b> 行
      </span>
      <Button variant="default" size="sm" className="primary" disabled={staging || n === 0} onClick={() => void stageSelection()} title="s">
        {staging ? '处理中…' : mode === 'stage' ? '暂存所选' : '取消暂存所选'}
        <kbd>s</kbd>
      </Button>
      <Button variant="outline" size="sm" onClick={() => setStageSel(null)} title="Esc">
        放弃
        <kbd>Esc</kbd>
      </Button>
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
        <Button variant="ghost" size="sm" className="link" onClick={() => void openFile(activeFile, true)}>
          重试
        </Button>
      </div>
    );
  else if (diffState.diff.binary) body = <div className="placeholder">二进制文件，不展示 diff</div>;
  else if (diffState.diff.hunks.length === 0)
    body = (
      <div className="placeholder">
        {entry.oldMode && entry.newMode
          ? `仅文件模式变更：${entry.oldMode} → ${entry.newMode}`
          : entry.status === 'renamed'
            ? '仅重命名，内容无变化'
            : '空文件 / 无内容变化'}
      </div>
    );
  else if (lineCount > BIG_FILE_LINES && forceBig !== activeFile)
    body = (
      <div className="placeholder">
        <p>该文件 diff 有 {lineCount} 行，默认不渲染。</p>
        <Button variant="default" size="sm" className="primary" onClick={() => setForceBig(activeFile)}>
          仍然渲染
        </Button>
      </div>
    );
  else body = <DiffView key={activeFile + ':' + diffState.diff.contentHash} diff={diffState.diff} />;

  return (
    <div className="diff-panel">
      <FileHeader entry={entry} />
      {body}
      <StageBar filePath={activeFile} />
    </div>
  );
}
