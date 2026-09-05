'use strict';

// Set a valid encryption key BEFORE any module loading so encrypt/decrypt
// round-trips work offline (mirrors analysisJournal.test.js's env-first rule).
process.env.LLM_ENCRYPTION_KEY = process.env.LLM_ENCRYPTION_KEY ||
  Buffer.alloc(32, 'k').toString('base64');

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ── Mock ./ssrfGuard BEFORE ../lib/llmProviders loads ──────────────────────
// Lets the timeout-lifecycle suite drive analyzeOpenAICompatible /
// analyzeAnthropic through their real code paths with no network access.
const ssrfGuardPath = require.resolve('../lib/ssrfGuard');
let fakeResponse = null;
require.cache[ssrfGuardPath] = {
  id: ssrfGuardPath,
  filename: ssrfGuardPath,
  loaded: true,
  exports: {
    isSafeUrl: async () => true,
    safeFetch: async () => {
      if (!fakeResponse) throw new Error('safeFetch called without a stubbed response');
      return fakeResponse;
    },
  },
};

const {
  getBaseUrl, PROVIDERS, prepareApiKey, analyze,
} = require('../lib/llmProviders');

// ── getBaseUrl ─────────────────────────────────────────────────────────────

describe('getBaseUrl', () => {
  test('openai → hardcoded URL, ignores llmEndpoint', () => {
    const result = getBaseUrl({ llmProvider: 'openai', llmEndpoint: 'https://evil.example.com' });
    assert.strictEqual(result, 'https://api.openai.com/v1');
  });

  test('deepseek → hardcoded URL, ignores llmEndpoint', () => {
    const result = getBaseUrl({ llmProvider: 'deepseek', llmEndpoint: 'https://evil.example.com' });
    assert.strictEqual(result, 'https://api.deepseek.com');
  });

  test('anthropic → null (uses analyzeAnthropic directly), ignores llmEndpoint', () => {
    const result = getBaseUrl({ llmProvider: 'anthropic', llmEndpoint: 'https://evil.example.com' });
    assert.strictEqual(result, null);
  });

  test('ollama → uses llmEndpoint when provided', () => {
    const result = getBaseUrl({ llmProvider: 'ollama', llmEndpoint: 'http://my-ollama:11434/v1' });
    assert.strictEqual(result, 'http://my-ollama:11434/v1');
  });

  test('ollama → falls back to localhost default', () => {
    const result = getBaseUrl({ llmProvider: 'ollama' });
    assert.strictEqual(result, 'http://localhost:11434/v1');
  });

  test('custom → uses llmEndpoint when provided', () => {
    const result = getBaseUrl({ llmProvider: 'custom', llmEndpoint: 'https://my-proxy.example.com/v1' });
    assert.strictEqual(result, 'https://my-proxy.example.com/v1');
  });

  test('custom → returns empty string when no endpoint', () => {
    const result = getBaseUrl({ llmProvider: 'custom' });
    assert.strictEqual(result, '');
  });

  test('unknown provider → null', () => {
    const result = getBaseUrl({ llmProvider: 'nonexistent' });
    assert.strictEqual(result, null);
  });

  test('all providers are listed in PROVIDERS', () => {
    assert.deepStrictEqual(Object.keys(PROVIDERS).sort(), ['anthropic', 'custom', 'deepseek', 'ollama', 'openai']);
  });
});

// ── Endpoint hijack prevention ─────────────────────────────────────────────

describe('endpoint hijack prevention', () => {
  const evilEndpoint = 'https://attacker.example.com/steal';

  test('openai + evil endpoint → still returns openai URL', () => {
    assert.strictEqual(
      getBaseUrl({ llmProvider: 'openai', llmEndpoint: evilEndpoint }),
      'https://api.openai.com/v1'
    );
  });

  test('deepseek + evil endpoint → still returns deepseek URL', () => {
    assert.strictEqual(
      getBaseUrl({ llmProvider: 'deepseek', llmEndpoint: evilEndpoint }),
      'https://api.deepseek.com'
    );
  });

  test('anthropic + evil endpoint → still returns null', () => {
    assert.strictEqual(
      getBaseUrl({ llmProvider: 'anthropic', llmEndpoint: evilEndpoint }),
      null
    );
  });
});

// ── Deterministic even sampling (implementation-backed structural checks) ──
// These asserts pin the real AnalysisController implementation directly
// (single source of truth) rather than any suite-side reimplementation.

describe('deterministic even sampling (implementation)', () => {
  const controllerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'AnalysisController.js'),
    'utf8'
  );

  test('no ORDER BY random() remains in the sample query', () => {
    assert.doesNotMatch(controllerSrc, /ORDER BY random\(\)/i);
  });

  test('sample selection is driven by an index-only id scan', () => {
    assert.match(
      controllerSrc,
      /SELECT id FROM "Logs" WHERE "sessionId" = :sessionId ORDER BY id/
    );
  });

  test('sampled rows are fetched by primary key in one query', () => {
    assert.match(controllerSrc, /WHERE id IN \(:ids\) ORDER BY id/);
  });

  test('even-spacing selection capped at 100 samples', () => {
    assert.match(controllerSrc, /const target = Math\.min\(100, ids\.length\)/);
    assert.match(controllerSrc, /Math\.max\(1, Math\.floor\(ids\.length \/ target\)\)/);
    assert.match(controllerSrc, /for \(let i = 0; i < ids\.length && sampledIds\.length < target; i \+= step\)/);
  });

  test('firstBatch/randomBatch/lastBatch merge order preserved', () => {
    assert.match(controllerSrc, /sample = \[\.\.\.firstBatch, \.\.\.randomBatch, \.\.\.lastBatch\]/);
  });
});

// ── Timeout lifecycle (behavioral over mocked safeFetch + structural) ──────

describe('timeout lifecycle (body-phase)', () => {
  const providersSrc = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'llmProviders.js'),
    'utf8'
  );

  function openAISettings() {
    return { llmProvider: 'openai', llmApiKeyEnc: prepareApiKey('sk-test') };
  }

  function anthropicSettings() {
    return { llmProvider: 'anthropic', llmApiKeyEnc: prepareApiKey('sk-test') };
  }

  // Replace setTimeout/clearTimeout with recording stubs so no real
  // timer is ever armed and we can observe exactly when handles are managed.
  function stubTimers(t) {
    const armed = [];
    const cleared = [];
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
      const handle = { fake: true, id: armed.length + 1 };
      armed.push({ fn, ms, handle });
      return handle;
    });
    t.mock.method(globalThis, 'clearTimeout', (handle) => {
      cleared.push(handle);
    });
    return { armed, cleared };
  }

  test('structural: source uses timeoutGuard.clear() instead of clearTimeout(timeout)', () => {
    // The old code had clearTimeout(timeout) in both !res.ok branches.
    // The new code uses timeoutGuard.clear() — no raw clearTimeout(timeout) in providers.
    const rawClears = providersSrc.match(/clearTimeout\(timeout\)/g) || [];
    assert.strictEqual(rawClears.length, 0, 'no raw clearTimeout(timeout) should remain in llmProviders.js');

    const guardClears = providersSrc.match(/timeoutGuard\.clear\(\)/g) || [];
    assert.strictEqual(guardClears.length, 2, 'exactly two timeoutGuard.clear() calls');
  });

  test('structural: both analyze functions return timeoutGuard (not raw timeout handle)', () => {
    const returns = providersSrc.match(/return \{ response: res, abortController: ac, timeoutGuard \}/g) || [];
    assert.strictEqual(returns.length, 2);
  });

  test('ok response: bump() transitions from connect ceiling to inactivity window', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: true };

    const result = await analyze('hi', openAISettings());

    // Constructor arms the connect ceiling (first setTimeout), and bump()
    // clears it and re-arms the inactivity window — so 2 armed total.
    assert.strictEqual(armed.length, 2);
    assert.strictEqual(armed[0].ms, 300_000);
    assert.strictEqual(armed[1].ms, 90_000);

    // ok response calls bump() — clears connect, arms inactivity
    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0], armed[0].handle);

    // The guard is returned, not the raw handle
    assert.ok(result.timeoutGuard);
    assert.strictEqual(typeof result.timeoutGuard.bump, 'function');
    assert.strictEqual(typeof result.timeoutGuard.clear, 'function');
    assert.strictEqual(result.response, fakeResponse);
    assert.strictEqual(typeof result.abortController.abort, 'function');
  });

  test('!res.ok clears the guard before throwing', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: false, status: 500, text: async () => 'boom' };

    await assert.rejects(
      () => analyze('hi', openAISettings()),
      /LLM API error 500: boom/
    );

    // clear() was called (one clearTimeout)
    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0], armed[0].handle);
  });

  test('anthropic: ok response bumps to inactivity window', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: true };

    const result = await analyze('hi', anthropicSettings());

    assert.strictEqual(armed.length, 2); // connect + bump
    assert.strictEqual(cleared.length, 1); // bump clears connect
    assert.ok(result.timeoutGuard);
  });

  test('anthropic: !res.ok clears before throwing', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: false, status: 401, text: async () => 'bad key' };

    await assert.rejects(
      () => analyze('hi', anthropicSettings()),
      /Anthropic API error 401: bad key/
    );

    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0], armed[0].handle);
  });

  test('bump() resets the inactivity window', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: true };

    const result = await analyze('hi', openAISettings());
    // After analyze: armed[0]=connect (cleared by bump), armed[1]=inactivity

    // Simulate consumer calling bump() on each streamed event
    result.timeoutGuard.bump();
    result.timeoutGuard.bump();
    result.timeoutGuard.bump();

    // Each bump: 1 clearTimeout + 1 setTimeout
    assert.strictEqual(cleared.length, 4); // 1 from analyze + 3 from bumps
    assert.strictEqual(armed.length, 5);   // 1 connect + 1 bump-in-analyze + 3 bumps

    // clear() disarms permanently
    result.timeoutGuard.clear();
    assert.strictEqual(cleared.length, 5);
  });
});

// ── Stream [DONE] exit logic (pure simulation) ─────────────────────────────

describe('stream [DONE] exit logic', () => {
  // Simulate the labeled-break pattern from AnalysisController
  function simulateStream(chunks) {
    const output = [];
    let done = false;
    for (const chunk of chunks) {
      if (done) break; // outer loop exits on [DONE]
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          done = true;
          break; // inner break + done flag exits outer
        }
        output.push(data);
      }
    }
    return output;
  }

  test('[DONE] mid-stream → stops processing remaining chunks', () => {
    const chunks = [
      'data: {"text":"hello"}\n',
      'data: {"text":"world"}\ndata: [DONE]\n',
      'data: {"text":"should-be-ignored"}\n',
    ];
    const result = simulateStream(chunks);
    assert.deepStrictEqual(result, ['{"text":"hello"}', '{"text":"world"}']);
  });

  test('[DONE] as only chunk → returns empty', () => {
    const result = simulateStream(['data: [DONE]\n']);
    assert.deepStrictEqual(result, []);
  });

  test('no [DONE] → processes all chunks', () => {
    const chunks = [
      'data: {"text":"a"}\n',
      'data: {"text":"b"}\n',
    ];
    const result = simulateStream(chunks);
    assert.deepStrictEqual(result, ['{"text":"a"}', '{"text":"b"}']);
  });

  test('[DONE] after reader done → processes everything', () => {
    const chunks = [
      'data: {"text":"a"}\n',
      'data: {"text":"b"}\n',
    ];
    const result = simulateStream(chunks);
    assert.deepStrictEqual(result, ['{"text":"a"}', '{"text":"b"}']);
  });
});
