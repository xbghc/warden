import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyAcpUpdate, type AcpAction, type AcpModel, type WorkbenchModel } from '@warden/shared';
import { WorkbenchApp } from './workbench';
import { AcpApp } from './acp';
import { bridge } from './bridge';
import './styles.css';

type View = { type: 'model'; model: WorkbenchModel } | { type: 'acp-model'; model: AcpModel } | { type: 'acp-empty' };

function App() {
  const [view, setView] = useState<View>();
  // Messages can arrive faster than React renders, so the model an update builds on is kept here.
  // A stable sender also lets memoized transcript rows skip re-rendering on every streamed model.
  const latest = useRef<View>();
  useEffect(() => {
    const show = (next: View) => {
      latest.current = next;
      setView(next);
    };
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'model' || event.data?.type === 'acp-model' || event.data?.type === 'acp-empty') show(event.data);
      else if (event.data?.type === 'acp-update') {
        const model = latest.current?.type === 'acp-model' ? applyAcpUpdate(latest.current.model, event.data.update) : undefined;
        // An update made for another model cannot be applied; the host answers with a whole one.
        if (model) show({ type: 'acp-model', model });
        else bridge.ready();
      }
    };
    window.addEventListener('message', receive);
    bridge.ready();
    return () => window.removeEventListener('message', receive);
  }, []);
  const sendAcp = useCallback((action: AcpAction) => {
    if (latest.current?.type === 'acp-model') bridge.acpAction(latest.current.model, action);
  }, []);
  if (!view) return <main>Loading workspace…</main>;
  if (view.type === 'acp-empty') return <main />;
  if (view.type === 'acp-model') return <AcpApp key={view.model.panelId} model={view.model} send={sendAcp} />;
  return (
    <WorkbenchApp
      key={`${view.model.session}:${view.model.surface}`}
      model={view.model}
      send={(action) => bridge.action(view.model, action)}
      saved={{ load: bridge.state, save: bridge.saveState }}
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
