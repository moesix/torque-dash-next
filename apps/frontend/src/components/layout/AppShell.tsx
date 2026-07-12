import { Outlet, useNavigate } from 'react-router-dom';
import { logout } from '@/lib/api';

/**
 * Application chrome: persistent sidebar + topbar with logout. Child routes
 * render through <Outlet/>.
 */
export default function AppShell() {
  const navigate = useNavigate();

  async function onLogout() {
    try {
      await logout();
    } catch {
      // ignore — we redirect regardless
    }
    navigate('/login');
  }

  return (
    <div className="flex h-full w-full bg-gray-50">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-gray-200 bg-white p-4 md:flex">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-blue-600" />
          <span className="text-lg font-bold tracking-tight text-gray-900">
            TorqueDash
          </span>
        </div>
        <nav className="flex flex-col gap-1 text-sm text-gray-600">
          <a
            href="/"
            className="rounded-md px-3 py-2 font-medium text-gray-900 hover:bg-gray-100"
          >
            Sessions
          </a>
          <a
            href="/settings"
            className="rounded-md px-3 py-2 font-medium text-gray-600 hover:bg-gray-100"
          >
            Settings
          </a>
          <span className="px-3 py-2 text-xs uppercase tracking-wide text-gray-400">
            Telemetry replay
          </span>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
          <span className="text-sm font-medium text-gray-500">
            TorqueDash Next
          </span>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Log out
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
