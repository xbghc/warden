import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
// Code uses the Latin mono subset; interface text uses the system face.
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
