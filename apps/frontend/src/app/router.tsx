import { lazy } from 'react';
import type { RouteObject } from 'react-router';
import AppShell from '@/components/layout/AppShell';
import Login from '@/features/auth/Login';

const Register = lazy(() => import('@/features/auth/Register'));
const SessionBrowser = lazy(() => import('@/features/sessions/SessionBrowser'));
const ReplayDashboard = lazy(() => import('@/features/dashboard/ReplayDashboard'));
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'));

// Route tree. /login and /register are public; everything else renders inside
// the authenticated AppShell. Auth enforcement is done at the data layer: any
// 401 from a protected call redirects to /login (see lib/api.ts).
//
// Heavy routes are code-split (React.lazy) so first paint for login/register
// downloads only react + router + auth UI. SessionBrowser/ReplayDashboard/
// SettingsPage pull echarts/zrender/leaflet, which land in their own async
// chunks and are fetched only when the route is actually opened. AppShell and
// Login stay static — neither imports chart/map code.
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
