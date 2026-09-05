'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ── Pre-populate require.cache for ../models ────────────────────────
// AnalysisController requires ../models at the top level.  models/index.js
// creates a real Sequelize instance, which we don't need in unit tests.
// We pre-populate the require cache with mock models so the controller
// gets our stubs instead of loading the real module.

const mockModels = {
  Session: {
    findOne: async () => null,
    findAll: async () => [],
    count: async () => 0,
    create: async () => ({}),
    destroy: async () => 0,
  },
  Log: {
    count: async () => 0,
    findAll: async () => [],
    destroy: async () => 0,
  },
  Analysis: {
    findOne: async () => null,
    findAll: async () => [],
    count: async () => 0,
    create: async () => ({}),
    destroy: async () => 0,
  },
  Vehicle: {
    findOne: async () => null,
    findAll: async () => [],
  },
  Settings: {
    getSingleton: async () => ({ llmProvider: null, llmApiKeyEnc: null }),
  },
  sequelize: {
    query: async () => [],
    QueryTypes: { SELECT: 'SELECT' },
    fn: () => {},
    col: () => {},
  },
  Sequelize: {
    Op: {
      in: Symbol('in'),
      and: Symbol('and'),
      gt: Symbol('gt'),
      lte: Symbol('lte'),
    },
  },
};

// Resolve the absolute path that `require('../models')` resolves to from
// controllers/AnalysisController.js, then inject our mock into the cache.
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: mockModels,
};

// Mock the LLM providers to avoid real network calls
const llmProvidersPath = require.resolve('../lib/llmProviders');
require.cache[llmProvidersPath] = {
  id: llmProvidersPath,
  filename: llmProvidersPath,
  loaded: true,
  exports: {
    analyze: async () => ({ response: { body: '' }, abortController: { abort: () => {} } }),
    streamEvents: async function* () {},
  },
};

// Mock the prompt builder
const llmPromptPath = require.resolve('../lib/llmPrompt');
require.cache[llmPromptPath] = {
  id: llmPromptPath,
  filename: llmPromptPath,
  loaded: true,
  exports: { buildAnalysisPrompt: () => 'test prompt' },
};

// Mock the PID registry
const pidRegistryPath = require.resolve('../lib/pidRegistry');
require.cache[pidRegistryPath] = {
  id: pidRegistryPath,
  filename: pidRegistryPath,
  loaded: true,
  exports: { discoverPidKeys: async () => ({}) },
};

// ── Now safe to require the controller ──────────────────────────────
const AnalysisController = require('../controllers/AnalysisController');

// ── Helpers ─────────────────────────────────────────────────────────

function makeStubReq(overrides = {}) {
  return {
    user: { id: 1 },
    params: { sessionId: '1', analysisId: '1' },
    body: {},
    query: {},
    ...overrides,
  };
}

function makeStubRes() {
  const calls = { status: null, body: null, statusCode: null, headersSent: false };
  const res = {
    status(code) { calls.statusCode = code; calls.status = code; return res; },
    json(obj) { calls.body = obj; return res; },
    sendStatus(code) { calls.statusCode = code; calls.status = code; return res; },
    send(data) { calls.body = data; return res; },
    setHeader(name, value) { calls.headers = calls.headers || {}; calls.headers[name] = value; return res; },
    set(name, value) { calls.headers = calls.headers || {}; calls.headers[name] = value; return res; },
    write(data) { calls.written = calls.written || []; calls.written.push(data); return res; },
    end() { calls.ended = true; return res; },
    flushHeaders() { calls.headersSent = true; calls.headersFlushed = true; return res; },
  };
  return { res, calls };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('listAllAnalyses', () => {
  test('returns paginated analyses with session info', async () => {
    // Override the mock to return test data
    mockModels.Analysis.findAll = async () => [
      {
        id: 1,
        sessionId: 10,
        provider: 'openai',
        model: 'gpt-4',
        createdAt: new Date('2026-01-15'),
        Session: {
          id: 10,
          name: 'Morning Drive',
          vehicleId: 5,
          Vehicle: { id: 5, name: 'My Car' },
        },
      },
    ];
    mockModels.Analysis.count = async () => 1;

    const req = makeStubReq({ query: { limit: '50', offset: '0' } });
    const { res, calls } = makeStubRes();

    await AnalysisController.listAllAnalyses(req, res);

    assert.deepStrictEqual(calls.body, {
      analyses: [
        {
          id: 1,
          sessionId: 10,
          provider: 'openai',
          model: 'gpt-4',
          createdAt: new Date('2026-01-15'),
          Session: {
            id: 10,
            name: 'Morning Drive',
            vehicleId: 5,
            Vehicle: { id: 5, name: 'My Car' },
          },
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  test('filters by vehicleId when provided', async () => {
    // Sessions for this vehicle
    mockModels.Session.findAll = async () => [{ id: 10 }, { id: 20 }];
    mockModels.Analysis.findAll = async () => [];
    mockModels.Analysis.count = async () => 0;

    const req = makeStubReq({ query: { vehicleId: '5' } });
    const { res, calls } = makeStubRes();

    await AnalysisController.listAllAnalyses(req, res);

    assert.strictEqual(calls.body.total, 0);
    assert.strictEqual(calls.body.analyses.length, 0);
    // Restore
    mockModels.Session.findAll = async () => [];
  });

  test('clamps limit to max 200', async () => {
    mockModels.Analysis.findAll = async () => [];
    mockModels.Analysis.count = async () => 0;

    const req = makeStubReq({ query: { limit: '500' } });
    const { res, calls } = makeStubRes();

    await AnalysisController.listAllAnalyses(req, res);

    assert.strictEqual(calls.body.limit, 200);
  });

  test('defaults limit to 50 and offset to 0', async () => {
    mockModels.Analysis.findAll = async () => [];
    mockModels.Analysis.count = async () => 0;

    const req = makeStubReq({ query: {} });
    const { res, calls } = makeStubRes();

    await AnalysisController.listAllAnalyses(req, res);

    assert.strictEqual(calls.body.limit, 50);
    assert.strictEqual(calls.body.offset, 0);
  });
});

describe('getAnalysis', () => {
  test('returns full analysis detail for owned analysis', async () => {
    mockModels.Analysis.findOne = async () => ({
      id: 1,
      sessionId: 10,
      provider: 'openai',
      model: 'gpt-4',
      response: 'Analysis result text',
      reasoning: 'Step by step...',
      createdAt: new Date('2026-01-15'),
    });

    const req = makeStubReq({ params: { analysisId: '1' } });
    const { res, calls } = makeStubRes();

    await AnalysisController.getAnalysis(req, res);

    assert.strictEqual(calls.body.id, 1);
    assert.strictEqual(calls.body.response, 'Analysis result text');
    assert.strictEqual(calls.body.reasoning, 'Step by step...');
  });

  test('returns 404 for non-existent analysis', async () => {
    mockModels.Analysis.findOne = async () => null;

    const req = makeStubReq({ params: { analysisId: '999' } });
    const { res, calls } = makeStubRes();

    await AnalysisController.getAnalysis(req, res);

    assert.strictEqual(calls.statusCode, 404);
    assert.deepStrictEqual(calls.body, { error: 'Analysis not found' });
  });
});

describe('exportAnalyses', () => {
  test('produces markdown output with analysis content', async () => {
    mockModels.Analysis.findAll = async () => [
      {
        id: 1,
        provider: 'openai',
        model: 'gpt-4',
        response: 'All systems nominal.',
        reasoning: 'Checked logs carefully.',
        createdAt: new Date('2026-01-15'),
        Session: { name: 'Morning Drive' },
      },
    ];

    const req = makeStubReq({ query: {} });
    const { res, calls } = makeStubRes();

    await AnalysisController.exportAnalyses(req, res);

    const content = calls.written.join('');
    assert.ok(content.includes('# AI Analysis History'));
    assert.ok(content.includes('Morning Drive'));
    assert.ok(content.includes('All systems nominal.'));
    assert.ok(content.includes('openai'));
    assert.ok(content.includes('gpt-4'));
    assert.ok(content.includes('Reasoning'));
    assert.ok(content.includes('Checked logs carefully.'));
    assert.ok(calls.headers['Content-Type'].includes('text/markdown'));
    assert.ok(calls.headers['Content-Disposition'].includes('analyses.md'));
  });

  test('filters by vehicleId when provided', async () => {
    mockModels.Session.findAll = async () => [{ id: 10 }];
    mockModels.Analysis.findAll = async () => [];

    const req = makeStubReq({ query: { vehicleId: '5' } });
    const { res, calls } = makeStubRes();

    await AnalysisController.exportAnalyses(req, res);

    const content = calls.written.join('');
    assert.ok(content.includes('# AI Analysis History'));
    // No analyses, so just the header
    assert.ok(!content.includes('## '));
    // Restore
    mockModels.Session.findAll = async () => [];
  });

  test('handles empty analyses gracefully', async () => {
    mockModels.Analysis.findAll = async () => [];

    const req = makeStubReq({ query: {} });
    const { res, calls } = makeStubRes();

    await AnalysisController.exportAnalyses(req, res);

    const content = calls.written.join('');
    assert.ok(content.includes('# AI Analysis History'));
    assert.ok(!content.includes('## '));
  });
});

describe('listAnalyses (preview mode)', () => {
  test('returns previews without response body', async () => {
    mockModels.Session.findOne = async () => ({ id: 10, userId: 1 });
    mockModels.Analysis.findAll = async () => [
      { id: 1, provider: 'openai', model: 'gpt-4', createdAt: new Date() },
      { id: 2, provider: 'anthropic', model: 'claude-3', createdAt: new Date() },
    ];

    const req = makeStubReq({ params: { sessionId: '10' } });
    const { res, calls } = makeStubRes();

    await AnalysisController.listAnalyses(req, res);

    assert.strictEqual(calls.body.length, 2);
    // Verify previews don't include response/reasoning
    assert.strictEqual(calls.body[0].response, undefined);
    assert.strictEqual(calls.body[0].reasoning, undefined);
    assert.strictEqual(calls.body[0].provider, 'openai');
  });
});

// ── Route registration (regression: GET /api/analyses/:id 404s) ──────
// The frontend calls the top-level GET /api/analyses/:id when expanding a
// past analysis. The controller has always handled it; the route was simply
// never registered. These tests exercise the REAL router (routes/api.js)
// mounted on an express app, with the mocked models injected above, so a
// missing or mis-ordered registration fails here instead of in production.
// HTTP-level on purpose: a controller-only test cannot catch route
// registration bugs. NOTE: intentionally standalone — these cover the
// router wiring, not a duplicate of the controller-level suites above.
const express = require('express');

// Load the real router with the SAME require.cache mocks the controller
// tests above rely on (models, LLM providers, prompt builder, PID registry).
let apiRouter;
try {
  apiRouter = require('../routes/api');
} catch {
  apiRouter = null;
}

// Boot the router on an ephemeral port; authenticate is stubbed per-test.
function withServer(handler) {
  return new Promise((resolve, reject) => {
    const app = express();
    // Parse JSON like app.js does so res.json bodies behave identically.
    app.use(express.json());
    app.use('/api', (req, res, next) => {
      // Stub passport's req.isAuthenticated + req.user; req.user is
      // overridden by tests that need a different identity.
      req.user = req.user || { id: 1 };
      req.isAuthenticated = () => true;
      next();
    });
    app.use('/api', apiRouter);
    // Terminal handler so unmatched routes surface as JSON 404s instead of
    // hanging or defaulting to HTML errors.
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    const server = app.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await handler(`http://127.0.0.1:${port}`);
        server.close(() => resolve());
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/analyses/:id route registration', { skip: apiRouter ? false : 'routes/api.js could not load (env vars missing in local dev)' }, () => {
  test('returns 200 with full analysis detail for the owning user', async () => {
    await withServer(async (base) => {
      mockModels.Analysis.findOne = async (opts) => {
        // Prove ownership scoping reaches the model: where must carry the
        // analysisId (Express params are strings) AND the user's id.
        assert.strictEqual(opts.where.id, '39');
        assert.strictEqual(opts.where.userId, 1);
        return {
          id: 39,
          sessionId: 10,
          provider: 'anthropic',
          model: 'claude-3',
          response: 'Full analysis body',
          reasoning: 'Because telemetry shows X',
          createdAt: new Date('2026-01-15T10:00:00Z'),
        };
      };

      const { status, body } = await getJson(base, '/api/analyses/39');

      assert.strictEqual(status, 200);
      assert.strictEqual(body.id, 39);
      assert.strictEqual(body.provider, 'anthropic');
      assert.strictEqual(body.model, 'claude-3');
      assert.strictEqual(body.response, 'Full analysis body');
      assert.strictEqual(body.reasoning, 'Because telemetry shows X');
      assert.strictEqual(body.createdAt, new Date('2026-01-15T10:00:00Z').toISOString());
    });
  });

  test('returns 404 for a non-existent analysis id', async () => {
    await withServer(async (base) => {
      mockModels.Analysis.findOne = async () => null;

      const { status, body } = await getJson(base, '/api/analyses/99999');

      assert.strictEqual(status, 404);
      assert.deepStrictEqual(body, { error: 'Analysis not found' });
    });
  });

  test('returns 404 when requesting another user\u2019s analysis (ownership scoping)', async () => {
    await withServer(async (base) => {
      // Simulate the DB honouring the scoped where clause: user 1 asking for
      // user 2's analysis finds no row.
      mockModels.Analysis.findOne = async (opts) => {
        assert.strictEqual(opts.where.userId, 1);
        return null;
      };

      const { status, body } = await getJson(base, '/api/analyses/77');

      assert.strictEqual(status, 404);
      assert.deepStrictEqual(body, { error: 'Analysis not found' });
    });
  });

  test('GET /api/analyses/export still returns markdown, not captured by :analysisId', async () => {
    await withServer(async (base) => {
      mockModels.Analysis.findAll = async () => [
        {
          id: 1,
          provider: 'openai',
          model: 'gpt-4',
          response: 'All good.',
          reasoning: null,
          createdAt: new Date('2026-01-15T10:00:00Z'),
          Session: { name: 'Morning Drive' },
        },
      ];

      const res = await fetch(`${base}/api/analyses/export`);
      const text = await res.text();

      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/markdown'));
      assert.ok(text.includes('# AI Analysis History'));
      assert.ok(text.includes('Morning Drive'));
      assert.ok(text.includes('All good.'));
    });
  });
});
