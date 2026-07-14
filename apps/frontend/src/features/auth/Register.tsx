import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Button } from '@tremor/react';
import { register, getSettings } from '@/lib/api';
import { useAuth } from './useAuth';

export default function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    getSettings()
      .then((s) => setDisabled(s.disableRegistration))
      .catch(() => setDisabled(false));
  }, []);

  if (isAuthenticated) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email, password);
      navigate('/login');
    } catch {
      setError('Registration failed. The email may already be registered.');
    } finally {
      setBusy(false);
    }
  }

  if (disabled) {
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

        {/* Right panel — closed notice */}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm">
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
              Registration closed
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              New account signups are currently disabled.
            </p>
            <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
              Already have an account?{' '}
              <a
                className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                href="/login"
              >
                Sign in
              </a>
            </p>
          </div>
        </div>
      </div>
    );
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
        <div className="w-full max-w-sm">
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
            Create account
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Start capturing Torque sessions.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Email
              </label>
              <input
                id="register-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'register-error' : undefined}
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
                id="register-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'register-error' : undefined}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm
                  focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20
                  dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            {error && (
              <p id="register-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Creating…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            Already have an account?{' '}
            <a
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
              href="/login"
            >
              Sign in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
