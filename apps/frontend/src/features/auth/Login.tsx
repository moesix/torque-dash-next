import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { login, getSettings } from '@/lib/api';
import { useAuth } from './useAuth';
import AuthBranding from './AuthBranding';
import { useVersion } from '@/lib/useVersion';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registrationDisabled, setRegistrationDisabled] = useState(false);
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { version } = useVersion();

  useEffect(() => {
    getSettings()
      .then((s) => setRegistrationDisabled(s?.disableRegistration ?? false))
      .catch(() => setRegistrationDisabled(false));
  }, []);

  if (isAuthenticated) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const ok = await login(email, password).catch((err: unknown) => {
      // login() throws ApiError(message, status) on failed logins (bad
      // credentials, rate limit); surface the server's message.
      setError(err instanceof Error ? err.message : 'Invalid email or password.');
      return false;
    });
    setBusy(false);
    if (ok) navigate('/');
    else setError((prev) => prev || 'Invalid email or password.');
  }

  return (
    <div className="flex min-h-full">
      {/* Left branding panel — hidden on mobile */}
      <AuthBranding />

      {/* Right panel — form */}
      <div className="flex flex-1 items-center justify-center p-4 md:p-6">
        <div className="animate-slide-up w-full max-w-sm">
          {/* Mobile-only logo */}
          <div className="mb-8 text-center lg:hidden">
            <img src="/brand/logo.svg" alt="" loading="eager" className="mx-auto mb-4 h-12 w-12 rounded-xl" />
            <h1
              className="text-2xl font-bold text-gray-900 dark:text-white"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              TorqueDash-Next
            </h1>
          </div>

          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Sign in
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Access your TorqueDash-Next sessions.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-3 text-sm
                  focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20
                  dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-3 text-sm
                  focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20
                  dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            {error && (
              <p id="login-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white
                shadow-xs transition hover:bg-indigo-700
                focus:outline-none focus:ring-2 focus:ring-indigo-500/20
                disabled:cursor-not-allowed disabled:opacity-50
                dark:bg-indigo-500 dark:hover:bg-indigo-600"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {registrationDisabled ? (
              'New account signups are disabled.'
            ) : (
              <>
                No account?{' '}
                <Link
                  to="/register"
                  className="font-medium text-teal-600 hover:text-teal-500 dark:text-teal-400"
                >
                  Register
                </Link>
              </>
            )}
          </p>
          {version && (
            <p className="mt-4 text-center text-sm text-gray-500 dark:text-gray-400">
              TorqueDash-Next v{version}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
