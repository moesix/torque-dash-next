import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Button, Card, Text, Title } from '@tremor/react';
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
      <div className="flex min-h-full items-center justify-center bg-gray-50 p-4">
        <Card className="w-full max-w-sm">
          <Title>Registration closed</Title>
          <Text className="mt-1">
            New account signups are currently disabled.
          </Text>
          <Text className="mt-4 text-sm">
            Already have an account?{' '}
            <a className="text-blue-600 underline" href="/login">
              Sign in
            </a>
          </Text>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-sm">
        <Title>Create account</Title>
        <Text className="mt-1">Start capturing Torque sessions.</Text>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          {error ? <Text className="text-sm text-rose-600">{error}</Text> : null}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>
        <Text className="mt-4 text-sm">
          Already have an account?{' '}
          <a className="text-blue-600 underline" href="/login">
            Sign in
          </a>
        </Text>
      </Card>
    </div>
  );
}
