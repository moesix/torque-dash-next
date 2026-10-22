import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { login, getSettings } from '@/lib/api';
import { useAuth } from './useAuth';
import AuthBranding from './AuthBranding';
import Button from '@/components/ui/Button';
import { useVersion } from '@/lib/useVersion';
import { MobileLogo } from '@/components/layout/brand';

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
          <MobileLogo />

          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Sign in
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Access your TorqueDash-Next sessions.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="login-email"
                className="block text-sm font-medium text-fg-secondary"
              >
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
                className="mt-1 w-full rounded-md border border-border bg-surface-card px-3 py-3 text-sm text-fg
                  focus:border-border-strong"
              />
            </div>
            <div>
              <label
                htmlFor="login-password"
                className="block text-sm font-medium text-fg-secondary"
              >
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
                className="mt-1 w-full rounded-md border border-border bg-surface-card px-3 py-3 text-sm text-fg
                  focus:border-border-strong"
              />
            </div>
            {error && (
              <p id="login-error" className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy}
              className="w-full"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {registrationDisabled ? (
              'New account signups are disabled.'
            ) : (
              <>
                No account?{' '}
                <Link
                  to="/register"
                  className="font-medium text-accent hover:text-accent-hover"
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
