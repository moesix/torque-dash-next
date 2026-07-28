import type {
  Session,
  TelemetryFrame,
  RawTelemetryRow,
  Settings,
  GenerateUploadTokenResponse,
  Analysis,
  UpdateLlmSettings,
  TestLlmResponse,
  Vehicle,
  UpdateVehicle,
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

async function request<T>(url: string, init?: RequestInit): Promise<T | undefined> {
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
  return undefined;
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
  await fetch('/api/users/logout', {
    method: 'POST',
    credentials: 'include',
  });
}

export interface PaginatedSessions {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
}

export async function getSessions(
  limit = 50,
  offset = 0,
  vehicleId?: number | 'none' | null,
): Promise<PaginatedSessions | undefined> {
  let url = `/api/sessions?limit=${limit}&offset=${offset}`;
  if (vehicleId === 'none') url += '&vehicleId=none';
  else if (vehicleId != null) url += `&vehicleId=${vehicleId}`;
  return request<PaginatedSessions>(url);
}

export async function getSession(id: string): Promise<Session | undefined> {
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

export async function getSettings(): Promise<Settings | undefined> {
  return request<Settings>('/api/settings');
}

export async function updateSettings(
  body: { disableRegistration?: boolean; uploadApiToken?: string | null; timezoneOffset?: number },
): Promise<Settings | undefined> {
  return request<Settings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Generate a new random upload API token (64 hex chars). The full token is
 *  returned in the response and will NEVER be visible again via GET. */
export async function generateUploadToken(): Promise<GenerateUploadTokenResponse | undefined> {
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

/** Update session notes. */
export async function updateSessionNotes(
  sessionId: string,
  notes: string | null,
): Promise<void> {
  await request(`/api/sessions/notes/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ notes }),
  });
}

// ── BYOK LLM Analysis ─────────────────────────────────────────────────

/** Update LLM provider and vehicle settings. */
export async function updateLlmSettings(body: UpdateLlmSettings): Promise<Settings | undefined> {
  return request<Settings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Test LLM connection. */
export async function testLlmConnection(): Promise<TestLlmResponse | undefined> {
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
export async function listAnalyses(sessionId: string): Promise<Analysis[] | undefined> {
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
 * Triggers a browser download — native streaming via <a href>, no Blob buffering.
 * The backend sets Content-Disposition: attachment so the browser saves the
 * file with the server-provided filename automatically.
 */
export async function exportSessionCsv(sessionId: string): Promise<void> {
  // Pre-check: verify the endpoint is reachable and user is authenticated
  const headRes = await fetch(`/api/sessions/${sessionId}/export/csv`, {
    method: 'HEAD',
    credentials: 'include',
  });

  if (headRes.status === 401) {
    if (!isAuthPage()) {
      window.location.assign('/login');
    }
    throw new ApiError('Unauthorized', 401);
  }
  if (!headRes.ok) {
    throw new ApiError(`Export failed with status ${headRes.status}`, headRes.status);
  }

  // Trigger native browser download — streams directly from the server,
  // bypassing JS memory entirely. The browser saves with the server's
  // Content-Disposition filename. The `download` attribute is a fallback.
  const a = document.createElement('a');
  a.href = `/api/sessions/${sessionId}/export/csv`;
  a.download = `session-${sessionId}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Vehicle CRUD ──────────────────────────────────────────────────────

/** List all vehicles for the current user. */
export async function getVehicles(): Promise<Vehicle[] | undefined> {
  return request<Vehicle[]>('/api/vehicles');
}

/** Get a single vehicle. */
export async function getVehicle(id: number): Promise<Vehicle | undefined> {
  return request<Vehicle>(`/api/vehicles/${id}`);
}

/** Create a new vehicle. */
export async function createVehicle(body: UpdateVehicle): Promise<Vehicle | undefined> {
  return request<Vehicle>('/api/vehicles', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Update a vehicle. */
export async function updateVehicle(
  id: number,
  body: UpdateVehicle,
): Promise<Vehicle | undefined> {
  return request<Vehicle>(`/api/vehicles/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** Delete a vehicle. */
export async function deleteVehicle(id: number): Promise<void> {
  await request(`/api/vehicles/${id}`, { method: 'DELETE' });
}

/** Set a vehicle as default. */
export async function setDefaultVehicle(id: number): Promise<Vehicle | undefined> {
  return request<Vehicle>(`/api/vehicles/${id}/default`, { method: 'PATCH' });
}

/** Reassign a session to a different vehicle. */
export async function reassignSessionVehicle(
  sessionId: string,
  vehicleId: number | null,
): Promise<void> {
  await request(`/api/sessions/${sessionId}/vehicle`, {
    method: 'PATCH',
    body: JSON.stringify({ vehicleId }),
  });
}

// ── Version ─────────────────────────────────────────────────────────────

export interface VersionResponse {
  version: string;
}

export async function getVersion(): Promise<VersionResponse> {
  const res = await fetch('/api/version', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch version');
  return res.json();
}
