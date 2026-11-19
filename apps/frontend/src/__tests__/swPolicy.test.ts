import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNavigation, shouldHandle } from '@/lib/swPolicy';

const ORIGIN = 'https://dash.test';

beforeEach(() => {
  // swPolicy.ts reads the global `location.origin`; node has no location.
  vi.stubGlobal('location', { origin: ORIGIN });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldHandle', () => {
  it('excludes app data under /api/ (network-only)', () => {
    expect(shouldHandle(`${ORIGIN}/api/sessions`, 'GET')).toBe(false);
    expect(shouldHandle(`${ORIGIN}/api/sessions/42/telemetry?page=1`, 'GET')).toBe(false);
    expect(shouldHandle(`${ORIGIN}/api/`, 'GET')).toBe(false);
  });

  it('does not treat lookalike paths as the API prefix', () => {
    expect(shouldHandle(`${ORIGIN}/apiary/map.geojson`, 'GET')).toBe(true);
  });

  it('excludes non-GET requests', () => {
    expect(shouldHandle(`${ORIGIN}/assets/index-abc123.js`, 'POST')).toBe(false);
    expect(shouldHandle(`${ORIGIN}/api/sessions`, 'DELETE')).toBe(false);
  });

  it('excludes cross-origin requests', () => {
    expect(shouldHandle('https://tiles.example.com/1/2/3.png', 'GET')).toBe(false);
    expect(shouldHandle('https://cdn.example.com/assets/index-abc123.js', 'GET')).toBe(false);
  });

  it('accepts hashed same-origin static assets', () => {
    expect(shouldHandle(`${ORIGIN}/assets/index-DNsWGCFQ.css`, 'GET')).toBe(true);
    expect(shouldHandle(`${ORIGIN}/assets/echarts-CWG5atP_.js`, 'GET')).toBe(true);
    expect(shouldHandle(`${ORIGIN}/manifest.webmanifest`, 'GET')).toBe(true);
  });

  it('accepts the app shell routes', () => {
    expect(shouldHandle(`${ORIGIN}/`, 'GET')).toBe(true);
    expect(shouldHandle(`${ORIGIN}/sessions/42`, 'GET')).toBe(true);
  });
});

describe('isNavigation', () => {
  it('detects navigation mode only', () => {
    expect(isNavigation('navigate')).toBe(true);
    expect(isNavigation('same-origin')).toBe(false);
    expect(isNavigation('no-cors')).toBe(false);
    expect(isNavigation('cors')).toBe(false);
  });
});
