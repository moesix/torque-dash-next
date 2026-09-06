import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { register, getSettings } from '@/lib/api';
import { useAuth } from './useAuth';
import AuthBranding from './AuthBranding';
import { MobileLogo } from '@/components/layout/brand';

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
      .then((s) => setDisabled(s?.disableRegistration ?? false))
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
        <AuthBranding />

        {/* Right panel — closed notice */}
        <div className="flex flex-1 items-center justify-center p-4 md:p-6">
          <div className="w-full max-w-sm">
            {/* Mobile-only logo */}
            <MobileLogo />

            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Registration closed
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              New account signups are currently disabled.
            </p>
            <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
              Already have an account?{' '}
              <Link
                to="/login"
                className="font-medium text-teal-600 hover:text-teal-500 dark:text-teal-400"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full">
      {/* Left branding panel — hidden on mobile */}
      <AuthBranding />

      {/* Right panel — form */}
      <div className="flex flex-1 items-center justify-center p-4 md:p-6">
        <div className="w-full max-w-sm">
          {/* Mobile-only logo */}
          <MobileLogo />

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
                id="register-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'register-error' : undefined}
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-3 text-sm
                  focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20
                  dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            {error && (
              <p id="register-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
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
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-medium text-teal-600 hover:text-teal-500 dark:text-teal-400"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
