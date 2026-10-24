import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkbenchModel } from '@warden/shared';
import { WorkbenchApp } from './workbench';
import { bridge } from './bridge';
import './styles.css';

function App() {
  const [model, setModel] = useState<WorkbenchModel>();
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === 'model') setModel(event.data.model);
    };
    window.addEventListener('message', receive);
    bridge.ready();
    return () => window.removeEventListener('message', receive);
  }, []);
  return model ? (
    <WorkbenchApp key={`${model.session}:${model.surface}`} model={model} send={(action) => bridge.action(model, action)} />
  ) : (
    <main>正在读取工作区…</main>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
