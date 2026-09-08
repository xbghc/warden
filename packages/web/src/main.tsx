import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
// Latin subsets only; CJK text renders in the system face (see the stacks in styles.css).
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
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
