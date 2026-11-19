import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Runtime tests for the generated worker (scripts/sw-template.js), executed in
 * a minimal vm sandbox with fake `self`, `caches` and `fetch`. The worker is
 * not importable (it is generated text), so we interpolate placeholders and
 * drive its event handlers directly. Node env — no jsdom needed.
 */

const ORIGIN = 'https://dash.test';
const TEMPLATE = readFileSync(new URL('../../scripts/sw-template.js', import.meta.url), 'utf8');
const PRECACHE = ['/', '/index.html', '/assets/index-abc123.js', '/assets/index-abc123.css', '/manifest.webmanifest', '/favicon.svg'];
const CODE = TEMPLATE.replace('__PRECACHE__', JSON.stringify(PRECACHE)).replace('__BUILD__', 'testbuild');

interface FakeResponse {
  ok: boolean;
  clone(): FakeResponse;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function response(ok = true): FakeResponse {
  const res: FakeResponse = { ok, clone: () => response(ok) };
  return res;
}

function request(url: string, method = 'GET', mode = 'same-origin') {
  return { url, method, mode };
}

function boot(fetchImpl: (req: unknown) => Promise<FakeResponse> = async () => response()) {
  const store = new Map<string, FakeResponse>();
  const deleted: string[] = [];
  // Cache keys are URLs: relative precache entries resolve against the origin,
  // exactly as a browser does.
  const norm = (key: unknown): string => {
    const raw = typeof key === 'string' ? key : (key as { url: string }).url;
    return raw.startsWith('/') ? new URL(raw, ORIGIN).href : raw;
  };
  const fetched: string[] = [];
  let claimCalled = false;
  const handlers: Record<string, (ev: any) => void> = {};

  const cache = {
    addAll: async (urls: string[]) => {
      for (const u of urls) store.set(norm(u), response());
    },
    put: async (key: unknown, res: FakeResponse) => {
      store.set(norm(key), res);
    },
  };
  const caches = {
    open: async () => cache,
    keys: async () => [...store.keys()],
    delete: async (key: string) => {
      deleted.push(key);
      store.delete(key);
      return true;
    },
    match: async (key: unknown) => store.get(norm(key)),
  };

  const sandbox: any = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (ev: any) => void) => {
        handlers[type] = handler;
      },
      skipWaiting: async () => {},
      clients: {
        claim: async () => {
          claimCalled = true;
        },
      },
    },
    caches,
    fetch: async (req: unknown) => {
      const r = req as { url: string };
      fetched.push(r.url);
      return fetchImpl(req);
    },
    URL,
    console,
  };
  runInContext(CODE, createContext(sandbox));

  async function fire(type: 'install' | 'activate' | 'fetch', req?: unknown) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<unknown> | undefined;
    const ev: any = {
      request: req,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<unknown>) => {
        responded = p;
      },
    };
    handlers[type](ev);
    await Promise.all(waits);
    return { responded, result: responded ? await responded : undefined };
  }

  return { store, deleted, fetched, fire, claimCalled: () => claimCalled, caches };
}

describe('generated service worker', () => {
  it('install precaches the shell list', async () => {
    const sw = boot();
    await sw.fire('install');
    for (const url of PRECACHE) expect(sw.store.has(new URL(url, ORIGIN).href)).toBe(true);
  });

  it('never intercepts /api/** — app data stays network-only and uncached', async () => {
    const sw = boot();
    const { responded } = await sw.fire('fetch', request(`${ORIGIN}/api/sessions`));
    expect(responded).toBeUndefined();
    expect(sw.fetched).toHaveLength(0);
    expect(sw.store.has(`${ORIGIN}/api/sessions`)).toBe(false);
  });

  it('never intercepts /api/** even as a navigation', async () => {
    const sw = boot();
    const { responded } = await sw.fire('fetch', request(`${ORIGIN}/api/sessions/1`, 'GET', 'navigate'));
    expect(responded).toBeUndefined();
    expect(sw.fetched).toHaveLength(0);
  });

  it('ignores non-GET requests', async () => {
    const sw = boot();
    const { responded } = await sw.fire('fetch', request(`${ORIGIN}/assets/index-abc123.js`, 'POST'));
    expect(responded).toBeUndefined();
    expect(sw.fetched).toHaveLength(0);
  });

  it('ignores cross-origin requests', async () => {
    const sw = boot();
    const { responded } = await sw.fire('fetch', request('https://tiles.example.com/1/2/3.png'));
    expect(responded).toBeUndefined();
    expect(sw.fetched).toHaveLength(0);
  });

  it('serves hashed assets cache-first', async () => {
    const sw = boot(async () => response());
    sw.store.set(`${ORIGIN}/assets/index-abc123.js`, response());
    const { result } = await sw.fire('fetch', request(`${ORIGIN}/assets/index-abc123.js`));
    expect(result).toBeDefined();
    expect(sw.fetched).toHaveLength(0); // cache hit → no network
  });

  it('fetches and caches an asset on a miss', async () => {
    const sw = boot(async () => response(true));
    const url = `${ORIGIN}/assets/index-abc123.js`;
    const { result } = await sw.fire('fetch', request(url));
    expect(result).toBeDefined();
    expect(sw.fetched).toEqual([url]);
    // put happens asynchronously after respondWith resolves; flush the queue.
    await flush();
    expect(sw.store.has(url)).toBe(true);
  });

  it('navigation is network-first and refreshes the cached shell', async () => {
    const sw = boot(async () => response(true));
    const { result } = await sw.fire('fetch', request(`${ORIGIN}/sessions/42`, 'GET', 'navigate'));
    expect(result).toBeDefined();
    expect(sw.fetched).toEqual([`${ORIGIN}/sessions/42`]);
    await flush();
    expect(sw.store.has(`${ORIGIN}/index.html`)).toBe(true);
  });

  it('navigation falls back to the cached shell when offline', async () => {
    const swipe = boot(async () => {
      throw new Error('offline');
    });
    const shell = response();
    swipe.store.set(`${ORIGIN}/index.html`, shell);
    const { result } = await swipe.fire('fetch', request(`${ORIGIN}/sessions/42`, 'GET', 'navigate'));
    expect(result).toBe(shell);
  });

  it('activate drops old tdn-* caches and claims clients', async () => {
    const sw = boot();
    sw.store.set('tdn-shell', response());
    sw.store.set('tdn-old', response());
    sw.store.set('other-cache', response());
    await sw.fire('activate');
    expect(sw.deleted).toEqual(['tdn-old']);
    expect(sw.store.has('tdn-shell')).toBe(true);
    expect(sw.store.has('other-cache')).toBe(true);
    expect(sw.claimCalled()).toBe(true);
  });
});
