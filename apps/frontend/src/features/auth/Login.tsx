import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Button } from '@tremor/react';
import { login, getSettings } from '@/lib/api';
import { useAuth } from './useAuth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registrationDisabled, setRegistrationDisabled] = useState(false);
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    getSettings()
      .then((s) => setRegistrationDisabled(s.disableRegistration))
      .catch(() => setRegistrationDisabled(false));
  }, []);

  if (isAuthenticated) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const ok = await login(email, password);
    setBusy(false);
    if (ok) navigate('/');
    else setError('Invalid email or password.');
  }

  return (
    <div className="flex min-h-full">
      {/* Left branding panel — hidden on mobile */}
      <div className="hidden w-1/2 items-center justify-center bg-blue-600 p-12 lg:flex">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 h-16 w-16 rounded-2xl bg-white/20 backdrop-blur" />
          <h1
            className="text-3xl font-bold text-white"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            TorqueDash
          </h1>
          <p className="mt-3 text-lg text-blue-100">
            Real-time vehicle telemetry replay and analysis.
          </p>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="animate-slide-up w-full max-w-sm">
          {/* Mobile-only logo */}
          <div className="mb-8 text-center lg:hidden">
            <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-blue-600" />
            <h1
              className="text-2xl font-bold text-gray-900 dark:text-white"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              TorqueDash
            </h1>
          </div>

          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Sign in
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Access your TorqueDash sessions.
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
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm
                  focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20
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
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm
                  focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20
                  dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            {error && (
              <p id="login-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {registrationDisabled ? (
              'New account signups are disabled.'
            ) : (
              <>
                No account?{' '}
                <a
                  className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                  href="/register"
                >
                  Register
                </a>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
