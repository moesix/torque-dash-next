import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/app/queryClient';
import App from '@/App';
import { applyTheme, getTheme } from '@/lib/theme';

// Apply saved theme before React renders — prevents flash of wrong theme
applyTheme(getTheme());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
