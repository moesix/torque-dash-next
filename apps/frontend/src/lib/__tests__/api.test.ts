import { describe, it, expect, vi, afterEach } from 'vitest';
import * as api from '../api';

describe('api module', () => {
    it('exports expected functions', () => {
        expect(typeof api.getSessions).toBe('function');
        expect(typeof api.login).toBe('function');
        expect(typeof api.logout).toBe('function');
        expect(typeof api.register).toBe('function');
        expect(typeof api.getSession).toBe('function');
        expect(typeof api.getTelemetry).toBe('function');
        expect(typeof api.getSettings).toBe('function');
        expect(typeof api.updateSettings).toBe('function');
        expect(typeof api.generateUploadToken).toBe('function');
        expect(typeof api.renameSession).toBe('function');
        expect(typeof api.updateSessionNotes).toBe('function');
        expect(typeof api.updateLlmSettings).toBe('function');
        expect(typeof api.testLlmConnection).toBe('function');
        expect(typeof api.analyzeSession).toBe('function');
        expect(typeof api.listAnalyses).toBe('function');
        expect(typeof api.deleteAnalysis).toBe('function');
        expect(typeof api.exportSessionCsv).toBe('function');
        expect(typeof api.getVehicles).toBe('function');
        expect(typeof api.createVehicle).toBe('function');
        expect(typeof api.updateVehicle).toBe('function');
        expect(typeof api.deleteVehicle).toBe('function');
        expect(typeof api.setDefaultVehicle).toBe('function');
        expect(typeof api.reassignSessionVehicle).toBe('function');
        expect(typeof api.getVersion).toBe('function');
    });

    it('exports ApiError class', () => {
        expect(api.ApiError).toBeDefined();
        const err = new api.ApiError('test', 404);
        expect(err.message).toBe('test');
        expect(err.status).toBe(404);
        expect(err.name).toBe('ApiError');
        expect(err instanceof Error).toBe(true);
    });
});

describe('request() auth redirect', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** node-env test: `request()` only touches window.location on a 401. */
    function stubWindowAt(pathname: string) {
        const assign = vi.fn();
        vi.stubGlobal('window', { location: { pathname, assign } });
        return assign;
    }

    it('redirects to /login and throws ApiError 401 from a protected page', async () => {
        const assign = stubWindowAt('/dashboard');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        )));

        const err = await api.getSessions().then(
            () => { throw new Error('expected rejection'); },
            (e: unknown) => e,
        );

        expect(assign).toHaveBeenCalledTimes(1);
        expect(assign).toHaveBeenCalledWith('/login');
        expect(err).toBeInstanceOf(api.ApiError);
        expect((err as InstanceType<typeof api.ApiError>).status).toBe(401);
    });

    it('does not redirect when already on an auth page, but still throws', async () => {
        const assign = stubWindowAt('/login');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        )));

        const err = await api.getSessions().then(
            () => { throw new Error('expected rejection'); },
            (e: unknown) => e,
        );

        expect(assign).not.toHaveBeenCalled();
        expect(err).toBeInstanceOf(api.ApiError);
        expect((err as InstanceType<typeof api.ApiError>).status).toBe(401);
    });
});

describe('request() response parsing', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the parsed body for a JSON 200 and undefined for a 204', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(
                JSON.stringify({ disableRegistration: true, tokenFromEnv: false }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(api.getSettings()).resolves.toEqual({
            disableRegistration: true,
            tokenFromEnv: false,
        });
        await expect(api.updateSettings({ disableRegistration: true })).resolves.toBeUndefined();
    });
});

describe('request() error body parsing', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses the backend { error } message as ApiError.message on a 400', async () => {
        // Any request()-based call works; getSettings is the simplest.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ error: 'Bad thing' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        )));

        const err = await api.getSettings().then(
            () => { throw new Error('expected rejection'); },
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(api.ApiError);
        expect((err as InstanceType<typeof api.ApiError>).message).toBe('Bad thing');
        expect((err as InstanceType<typeof api.ApiError>).status).toBe(400);
    });

    it('falls back to the status message when a 500 body is HTML', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '<html><body>Internal Server Error</body></html>',
            { status: 500, headers: { 'Content-Type': 'text/html' } },
        )));

        const err = await api.getSettings().then(
            () => { throw new Error('expected rejection'); },
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(api.ApiError);
        expect((err as InstanceType<typeof api.ApiError>).message).toBe('Request failed with status 500');
        expect((err as InstanceType<typeof api.ApiError>).status).toBe(500);
    });
});

describe('pageThrough', () => {
    // Timestamp-ASC rows, mirroring the telemetry endpoint contract.
    function rows(count: number, startMs = 0): { timestamp: string }[] {
        return Array.from({ length: count }, (_, i) => ({
            timestamp: new Date(startMs + i).toISOString(),
        }));
    }

    it('returns an empty result when the first page is empty', async () => {
        const cursors: string[] = [];
        const result = await api.pageThrough(
            (cursor) => {
                cursors.push(cursor);
                return Promise.resolve([]);
            },
            '1970-01-01T00:00:00.000Z',
            100000,
        );
        expect(result.items).toEqual([]);
        expect(result.truncated).toBe(false);
        expect(cursors).toEqual(['1970-01-01T00:00:00.000Z']);
    });

    it('stops after a single short page (< PAGE_SIZE)', async () => {
        let calls = 0;
        const result = await api.pageThrough(
            () => {
                calls++;
                return Promise.resolve(rows(3));
            },
            '1970-01-01T00:00:00.000Z',
            100000,
        );
        expect(result.items.length).toBe(3);
        expect(result.truncated).toBe(false);
        expect(calls).toBe(1);
    });

    it('continues paging through exact multiples until a short page arrives', async () => {
        const cursors: string[] = [];
        const pages = [rows(10000, 0), rows(10000, 10000), rows(5, 20000)];
        let call = 0;
        const result = await api.pageThrough(
            (cursor) => {
                cursors.push(cursor);
                return Promise.resolve(pages[call++]);
            },
            '1970-01-01T00:00:00.000Z',
            100000,
        );
        expect(result.items.length).toBe(20005);
        expect(result.truncated).toBe(false);
        expect(call).toBe(3);
        // Cursor advances 1ms past the previous page's last timestamp.
        expect(cursors[1]).toBe(new Date(10000).toISOString());
        expect(cursors[2]).toBe(new Date(20000).toISOString());
    });

    it('advances the cursor exactly 1ms past the last returned timestamp', async () => {
        const seenCursors: string[] = [];
        // The cursor only advances after a FULL page, so page 1 must carry
        // exactly PAGE_SIZE (10000) rows.
        const pages = [rows(10000, 5000), rows(1, 20000)];
        let call = 0;
        await api.pageThrough(
            (cursor) => {
                seenCursors.push(cursor);
                return Promise.resolve(pages[call++]);
            },
            '1970-01-01T00:00:00.000Z',
            100000,
        );
        // Last row of the full page 1 sits at ms 14999 → next cursor is 15000.
        expect(seenCursors[1]).toBe(new Date(15000).toISOString());
    });

    it('sets truncated:true once the hard cap is reached', async () => {
        const pages = [rows(10000, 0), rows(10000, 10000), rows(10000, 20000)];
        let call = 0;
        const result = await api.pageThrough(
            (_cursor) => Promise.resolve(pages[call++]),
            '1970-01-01T00:00:00.000Z',
            25000,
        );
        expect(result.truncated).toBe(true);
        expect(result.items.length).toBe(30000); // whole final full page is kept
        expect(call).toBe(3);
    });
});
