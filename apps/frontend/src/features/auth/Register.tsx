import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { register, getSettings } from '@/lib/api';
import { useAuth } from './useAuth';
import AuthBranding from './AuthBranding';
import Button from '@/components/ui/Button';
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
    } catch (err) {
      // register() throws ApiError(message, status) — the backend's validator
      // message (e.g. "email must be a valid email", "password ... min 8
      // characters") and 409 duplicate-email copy are worth surfacing verbatim,
      // same as Login. Bad-credential style failures fall back to a generic
      // server message only when the error carries none.
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Registration failed. The email may already be registered.',
      );
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
                className="font-medium text-accent hover:text-accent-hover"
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
              <label
                htmlFor="register-email"
                className="block text-sm font-medium text-fg-secondary"
              >
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
                className="mt-1 w-full rounded-md border border-border bg-surface-card px-3 py-3 text-sm text-fg
                  focus:border-border-strong"
              />
            </div>
            <div>
              <label
                htmlFor="register-password"
                className="block text-sm font-medium text-fg-secondary"
              >
                Password
              </label>
              <input
                id="register-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={`${error ? 'register-error ' : ''}register-password-hint`}
                className="mt-1 w-full rounded-md border border-border bg-surface-card px-3 py-3 text-sm text-fg
                  focus:border-border-strong"
              />
              <p id="register-password-hint" className="mt-1 text-xs text-fg-muted">
                At least 8 characters.
              </p>
            </div>
            {error && (
              <p id="register-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy}
              className="w-full"
            >
              {busy ? 'Creating…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-medium text-accent hover:text-accent-hover"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
