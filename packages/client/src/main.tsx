// fallow-ignore-file coverage-gaps -- the browser entry point: it only mounts App into the DOM, so there is nothing to import from a test
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
