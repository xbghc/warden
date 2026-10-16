import { Button } from './ui/button';
import { MessageSquare, X } from 'lucide-react';
import { useStore } from '../store';
import { CommentRail } from './CommentRail';

/** Review feedback stays beside the code; commit planning belongs in orchestration. */
export function Rail() {
  const open = useStore((s) => s.prefs.railOpen);
  const panel = useStore((s) => s.panel);
  const setRailOpen = useStore((s) => s.setRailOpen);
  if (!open) return null;
  return (
    <aside className="rail" hidden={panel === 'orchestration'} aria-label="审查评论">
      <div className="rail-head">
        <MessageSquare size={16} />
        <h2>评论</h2>
        <span className="spacer" />
        <Button variant="ghost" size="icon-sm" onClick={() => setRailOpen(false)} title="收起 (Esc)" aria-label="收起右栏">
          <X aria-hidden="true" />
        </Button>
      </div>
      <CommentRail />
    </aside>
  );
}
