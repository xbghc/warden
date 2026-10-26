import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AcpModel, WorkbenchModel } from '@warden/shared';
import { WorkbenchApp } from './workbench';
import { AcpApp } from './acp';
import { bridge } from './bridge';
import './styles.css';

function App() {
  const [view, setView] = useState<{ type: 'model'; model: WorkbenchModel } | { type: 'acp-model'; model: AcpModel }>();
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'model' || event.data?.type === 'acp-model') setView(event.data);
    };
    window.addEventListener('message', receive);
    bridge.ready();
    return () => window.removeEventListener('message', receive);
  }, []);
  if (!view) return <main>正在读取工作区…</main>;
  if (view.type === 'acp-model') return <AcpApp key={view.model.panelId} model={view.model} send={(action) => bridge.acpAction(view.model, action)} />;
  return (
    <WorkbenchApp key={`${view.model.session}:${view.model.surface}`} model={view.model} state={bridge} send={(action) => bridge.action(view.model, action)} />
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
