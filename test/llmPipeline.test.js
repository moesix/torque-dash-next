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
// The old suite tested a local copy of the selection math; these asserts pin
// the real AnalysisController implementation instead (single source of truth).

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

  // Replace setTimeout/clearTimeout with recording stubs so no real 120s
  // timer is ever armed and we can observe exactly when handles are cleared.
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

  test('structural: exactly two clearTimeout calls, both inside !res.ok branches', () => {
    const matches = providersSrc.match(/clearTimeout\(timeout\)/g) || [];
    assert.strictEqual(matches.length, 2);

    const lines = providersSrc.split('\n');
    let guarded = 0;
    lines.forEach((line, i) => {
      if (line.includes('clearTimeout(timeout)')) {
        const window = lines.slice(Math.max(0, i - 4), i).join('\n');
        if (window.includes('if (!res.ok)')) guarded++;
      }
    });
    assert.strictEqual(guarded, 2);
  });

  test('structural: both analyze functions return the timeout handle', () => {
    const returns = providersSrc.match(/return \{ response: res, abortController: ac, timeout \}/g) || [];
    assert.strictEqual(returns.length, 2);
  });

  test('ok response keeps the timeout armed — consumer clears it after the body read', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: true };

    const result = await analyze('hi', openAISettings());

    // Armed once for the full 120s and handed back to the caller…
    assert.strictEqual(armed.length, 1);
    assert.strictEqual(armed[0].ms, 120_000);
    assert.strictEqual(result.timeout, armed[0].handle);
    // …and NOT cleared when response headers arrive (the old bug).
    assert.strictEqual(cleared.length, 0);
    assert.strictEqual(result.response, fakeResponse);
    assert.strictEqual(typeof result.abortController.abort, 'function');

    // Consumer-side cleanup (controller's finally block):
    clearTimeout(result.timeout);
    assert.deepStrictEqual(cleared, [result.timeout]);
  });

  test('!res.ok clears the timeout before throwing (no body to wait for)', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: false, status: 500, text: async () => 'boom' };

    await assert.rejects(
      () => analyze('hi', openAISettings()),
      /LLM API error 500: boom/
    );

    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0], armed[0].handle);
  });

  test('anthropic: ok response returns the timeout handle uncleared', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: true };

    const result = await analyze('hi', anthropicSettings());

    assert.strictEqual(armed.length, 1);
    assert.strictEqual(result.timeout, armed[0].handle);
    assert.strictEqual(cleared.length, 0);
  });

  test('anthropic: !res.ok clears the timeout before throwing', async (t) => {
    const { armed, cleared } = stubTimers(t);
    fakeResponse = { ok: false, status: 401, text: async () => 'bad key' };

    await assert.rejects(
      () => analyze('hi', anthropicSettings()),
      /Anthropic API error 401: bad key/
    );

    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(cleared[0], armed[0].handle);
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
