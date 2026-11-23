import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/unbounded/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('The page has no #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
