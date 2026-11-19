import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/app/queryClient';
import { UnitSystemProvider } from '@/app/unitSystem';
import App from '@/App';
import { applyTheme, getTheme } from '@/lib/theme';

// Apply saved theme before React renders — prevents flash of wrong theme
applyTheme(getTheme());

// Register the generated offline shell in production only; the Vite dev
// server and HMR must stay unaffected.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <UnitSystemProvider>
        <App />
      </UnitSystemProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
