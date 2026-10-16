import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyStoredAppearance } from './utils/theme';
import './index.css';

// Before the first paint, so a dark theme never flashes white on load.
applyStoredAppearance();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
