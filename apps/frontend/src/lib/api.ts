import type {
  Session,
  TelemetryFrame,
  RawTelemetryRow,
  Settings,
  GenerateUploadTokenResponse,
  Analysis,
  UpdateLlmSettings,
  TestLlmResponse,
} from './types';

/**
 * Thin fetch wrapper. Every call uses `credentials: 'include'` so the
 * express-session cookie travels with the request (required for cross-origin
 * auth in production where the cookie is sameSite:none; secure). On a 401 from
 * a protected endpoint we bounce to /login — unless we are already on an auth
 * page (login/register), to avoid redirect loops.
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isAuthPage(): boolean {
  if (typeof window === 'undefined') return false;
  const p = window.location.pathname;
  return p === '/login' || p === '/register';
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  if (res.status === 401) {
    if (!isAuthPage()) {
      window.location.assign('/login');
    }
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    throw new ApiError(`Request failed with status ${res.status}`, res.status);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  // Non-JSON responses (e.g. the passport redirect on /login) carry no body we
  // parse; callers that expect JSON would have already thrown on !ok.
  return undefined as unknown as T;
}

function normalizeRow(row: RawTelemetryRow): TelemetryFrame {
  return {
    timestamp: row.timestamp,
    lon: row.lon,
    lat: row.lat,
    values: row.values,
    engineRpm: row.engine_rpm ?? null,
    vehicleSpeed: row.vehicle_speed ?? null,
  };
}

/**
 * Login. The backend answers the POST with JSON ({ ok: true }) on success or a
 * 401 JSON on failure, so we read the result directly. We still probe an
 * auth-gated endpoint afterwards as a cookie sanity check.
 */
export async function login(email: string, password: string): Promise<boolean> {
  await fetch('/api/users/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  try {
    await getSessions();
    return true;
  } catch {
    return false;
  }
}

export async function register(email: string, password: string): Promise<void> {
  await request('/api/users/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function logout(): Promise<void> {
  await request('/api/users/logout', { method: 'GET' });
}

export async function getSessions(): Promise<Session[]> {
  return request<Session[]>('/api/sessions');
}

export async function getSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${id}`);
}

export async function getTelemetry(
  id: string,
  from: string,
  to: string,
  limit = 10000,
): Promise<TelemetryFrame[]> {
  const url = `/api/sessions/${id}/telemetry?from=${encodeURIComponent(
    from,
  )}&to=${encodeURIComponent(to)}&limit=${limit}`;
  const rows = await request<RawTelemetryRow[]>(url);
  return (rows ?? []).map(normalizeRow);
}

export async function getSettings(): Promise<Settings> {
  return request<Settings>('/api/settings');
}

export async function updateSettings(
  body: { disableRegistration?: boolean; uploadApiToken?: string | null },
): Promise<Settings> {
  return request<Settings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Generate a new random upload API token (64 hex chars). The full token is
 *  returned in the response and will NEVER be visible again via GET. */
export async function generateUploadToken(): Promise<GenerateUploadTokenResponse> {
  return request<GenerateUploadTokenResponse>('/api/settings/upload-token', {
    method: 'POST',
  });
}

/** Rename a session. */
export async function renameSession(
  sessionId: string,
  name: string,
): Promise<void> {
  await request(`/api/sessions/rename/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

// ── BYOK LLM Analysis ─────────────────────────────────────────────────

/** Update LLM provider and vehicle settings. */
export async function updateLlmSettings(body: UpdateLlmSettings): Promise<Settings> {
  return request<Settings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Test LLM connection. */
export async function testLlmConnection(): Promise<TestLlmResponse> {
  return request<TestLlmResponse>('/api/settings/test-llm', {
    method: 'POST',
  });
}

/** Trigger AI analysis for a session. Returns a ReadableStream for SSE. */
export async function analyzeSession(
  sessionId: string,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`/api/sessions/${sessionId}/analyze`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (res.status === 401) {
    if (!isAuthPage()) window.location.assign('/login');
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Analysis failed' }));
    throw new ApiError(body.error || `Analysis failed (${res.status})`, res.status);
  }

  return res.body!;
}

/** List past analyses for a session. */
export async function listAnalyses(sessionId: string): Promise<Analysis[]> {
  return request<Analysis[]>(`/api/sessions/${sessionId}/analyses`);
}

/** Delete a cached analysis. */
export async function deleteAnalysis(sessionId: string, analysisId: number): Promise<void> {
  await request(`/api/sessions/${sessionId}/analyses/${analysisId}`, {
    method: 'DELETE',
  });
}

// ── CSV Export ─────────────────────────────────────────────────────────

/**
 * Export all telemetry data for a session as a CSV file.
 * Triggers a browser download with the filename from the server's
 * Content-Disposition header.
 */
export async function exportSessionCsv(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/export/csv`, {
    credentials: 'include',
  });

  if (res.status === 401) {
    if (!isAuthPage()) {
      window.location.assign('/login');
    }
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    throw new ApiError(`Export failed with status ${res.status}`, res.status);
  }

  // Extract filename from Content-Disposition header
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="?([^";\n]+)"?/);
  const filename = match?.[1] ?? `session-${sessionId}.csv`;

  // Create blob and trigger download via ephemeral <a> element
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
