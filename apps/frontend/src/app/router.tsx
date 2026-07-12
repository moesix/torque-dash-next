import type { RouteObject } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import Login from '@/features/auth/Login';
import Register from '@/features/auth/Register';
import SessionBrowser from '@/features/sessions/SessionBrowser';
import ReplayDashboard from '@/features/dashboard/ReplayDashboard';
import SettingsPage from '@/features/settings/SettingsPage';

// Route tree. /login and /register are public; everything else renders inside
// the authenticated AppShell. Auth enforcement is done at the data layer: any
// 401 from a protected call redirects to /login (see lib/api.ts).
export const routerConfig: RouteObject[] = [
  { path: '/login', element: <Login /> },
  { path: '/register', element: <Register /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <SessionBrowser /> },
      { path: 'session/:id', element: <ReplayDashboard /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
  { path: '*', element: <Login /> },
];
