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
// isSafeUrl stays REAL so the endpoint-gate suite exercises the guard.
const realSsrfGuard = require('../lib/ssrfGuard');
const ssrfGuardPath = require.resolve('../lib/ssrfGuard');
let fakeResponse = null;
const safeFetchCalls = [];
require.cache[ssrfGuardPath] = {
  id: ssrfGuardPath,
  filename: ssrfGuardPath,
  loaded: true,
  exports: {
    isSafeUrl: realSsrfGuard.isSafeUrl,
    safeFetch: async (url, init = {}) => {
      safeFetchCalls.push({ url, init });
      if (!fakeResponse) throw new Error('safeFetch called without a stubbed response');
      return fakeResponse;
    },
  },
};

const {
  getBaseUrl, PROVIDERS, prepareApiKey, analyze, streamEvents,
} = require('../lib/llmProviders');

// Real helpers under test (llmPrompt has no network/secret side effects).
const {
  formatSessionDuration, detectBackfillGaps, buildDataQualityNote,
} = require('../lib/llmPrompt');

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

// ── Endpoint SSRF gate + scoped loopback allowance ────────────────────────

describe('endpoint SSRF gate', () => {
  const lastCall = () => safeFetchCalls[safeFetchCalls.length - 1];
  const resetCalls = () => { safeFetchCalls.length = 0; };

  test('non-ollama provider with private llmEndpoint → throws before any request', async () => {
    resetCalls();
    fakeResponse = { ok: true };

    await assert.rejects(
      () => analyze('hi', {
        llmProvider: 'custom',
        llmEndpoint: 'http://10.1.2.3:8080/v1',
        llmApiKeyEnc: prepareApiKey('sk-test'),
      }),
      /failed safety validation/
    );
    assert.strictEqual(safeFetchCalls.length, 0);
  });

  test('non-ollama provider with loopback llmEndpoint → throws before any request', async () => {
    resetCalls();
    fakeResponse = { ok: true };

    await assert.rejects(
      () => analyze('hi', {
        llmProvider: 'custom',
        llmEndpoint: 'http://127.0.0.1:8080/v1',
        llmApiKeyEnc: prepareApiKey('sk-test'),
      }),
      /failed safety validation/
    );
    assert.strictEqual(safeFetchCalls.length, 0);
  });

  test('custom endpoint rejects loopback even when the caller requests allowLoopback', async () => {
    resetCalls();
    fakeResponse = { ok: true };

    await assert.rejects(
      () => analyze('hi', {
        llmProvider: 'custom',
        llmEndpoint: 'http://127.0.0.1:9/v1',
        llmApiKeyEnc: prepareApiKey('sk-test'),
      }, { allowLoopback: true }),
      /failed safety validation/
    );
    assert.strictEqual(safeFetchCalls.length, 0);
  });

  test('stray allowLoopback option never reaches safeFetch for a non-ollama provider', async () => {
    resetCalls();
    fakeResponse = { ok: true };

    const result = await analyze('hi', {
      llmProvider: 'custom',
      llmEndpoint: 'https://8.8.8.8/v1',
      llmApiKeyEnc: prepareApiKey('sk-test'),
    }, { allowLoopback: true });
    result.timeoutGuard.clear();

    // The sink gates the flag on llmProvider === 'ollama', so a caller-supplied
    // allowance cannot widen the guard for custom/openai/deepseek/etc.
    assert.strictEqual(lastCall().url, 'https://8.8.8.8/v1/chat/completions');
    assert.strictEqual(lastCall().init.allowLoopback, undefined);
  });

  test('ollama default endpoint (localhost) → passes with the scoped loopback flag', async () => {
    resetCalls();
    fakeResponse = { ok: true };

    const result = await analyze('hi', {
      llmProvider: 'ollama',
      llmApiKeyEnc: prepareApiKey('sk-test'),
    });
    result.timeoutGuard.clear();

    const call = lastCall();
    assert.strictEqual(call.url, 'http://localhost:11434/v1/chat/completions');
    assert.strictEqual(call.init.allowLoopback, true);
    assert.strictEqual(call.init.redirect, undefined, 'guard owns the redirect mode');
  });

  test('ollama explicit 127.0.0.1 endpoint → passes with the scoped loopback flag', async () => {
    resetCalls();
    fakeResponse = { ok: true };

    const result = await analyze('hi', {
      llmProvider: 'ollama',
      llmEndpoint: 'http://127.0.0.1:11434/v1',
      llmApiKeyEnc: prepareApiKey('sk-test'),
    });
    result.timeoutGuard.clear();

    const call = lastCall();
    assert.strictEqual(call.url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.strictEqual(call.init.allowLoopback, true);
  });

  test('non-loopback providers never request the loopback allowance', async () => {
    resetCalls();
    fakeResponse = { ok: true };

    const result = await analyze('hi', {
      llmProvider: 'openai',
      llmApiKeyEnc: prepareApiKey('sk-test'),
    });
    result.timeoutGuard.clear();

    assert.notStrictEqual(lastCall().init.allowLoopback, true);
  });
});

// ── DeepSeek thinking payload shape (TEST-03) ─────────────────────────────

describe('DeepSeek thinking payload', () => {
  function deepseekSettings(extra = {}) {
    return { llmProvider: 'deepseek', llmApiKeyEnc: prepareApiKey('sk-test'), ...extra };
  }

  async function capturedBody(settings) {
    safeFetchCalls.length = 0;
    fakeResponse = { ok: true };
    const result = await analyze('hi', settings);
    result.timeoutGuard.clear();
    const call = safeFetchCalls[safeFetchCalls.length - 1];
    return { url: call.url, body: JSON.parse(call.init.body) };
  }

  test('thinking enabled → thinking.enabled + reasoning_effort', async () => {
    const { url, body } = await capturedBody(
      deepseekSettings({ llmThinkingMode: true, llmReasoningEffort: 'medium' })
    );
    assert.strictEqual(url, 'https://api.deepseek.com/chat/completions');
    assert.deepStrictEqual(body.thinking, { type: 'enabled' });
    assert.strictEqual(body.reasoning_effort, 'medium');
    assert.strictEqual(body.model, 'deepseek-v4-flash');
    assert.strictEqual(body.stream, true);
  });

  test('thinking unset → defaults to enabled with high effort', async () => {
    const { body } = await capturedBody(deepseekSettings());
    assert.deepStrictEqual(body.thinking, { type: 'enabled' });
    assert.strictEqual(body.reasoning_effort, 'high');
  });

  test('thinking disabled → thinking.disabled and no reasoning_effort', async () => {
    const { body } = await capturedBody(
      deepseekSettings({ llmThinkingMode: false, llmReasoningEffort: 'high' })
    );
    assert.deepStrictEqual(body.thinking, { type: 'disabled' });
    assert.ok(!('reasoning_effort' in body));
  });
});

// ── Deterministic even sampling (implementation-backed structural checks) ──
// These asserts pin the real AnalysisController implementation directly
// (single source of truth) rather than any suite-side reimplementation.
// plans/014: the id list is now produced by a LIMIT-bounded ranked query, so
// the stride/target formula lives in SQL replacements instead of a JS loop.

describe('deterministic even sampling (implementation)', () => {
  const controllerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'AnalysisController.js'),
    'utf8'
  );

  test('no ORDER BY random() remains in the sample query', () => {
    assert.doesNotMatch(controllerSrc, /ORDER BY random\(\)/i);
  });

  test('sample id selection is a ranked, stride-filtered, LIMIT-bounded query', () => {
    assert.match(controllerSrc, /ROW_NUMBER\(\) OVER \(ORDER BY "id"\) AS rn/);
    assert.match(controllerSrc, /WHERE \(rn - 1\) % :stride = 0/);
    assert.match(controllerSrc, /LIMIT :target/);
  });

  test('sampled rows are fetched by primary key in one query', () => {
    assert.match(controllerSrc, /WHERE id IN \(:ids\) ORDER BY id/);
  });

  test('even-spacing selection capped at 100 samples with the pre-SQL formula', () => {
    assert.match(controllerSrc, /const target = Math\.min\(100, totalCount\)/);
    assert.match(controllerSrc, /Math\.max\(1, Math\.floor\(totalCount \/ target\)\)/);
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

// ── formatSessionDuration (real helper from lib/llmPrompt) ────────────────
// plans/087: the AI prompt must never contain a negative duration. Sessions
// are created AFTER trips when devices backfill logs, so createdAt can be
// later than every log timestamp — duration must come from log/session
// bounds only, and any inverted/missing span resolves to 'unknown'.

describe('formatSessionDuration', () => {
  // Prod-shaped span (Sessions row 76): 10:05:23.881 → 11:05:05.438 = 59m 41s
  test('normal span formats as zero-padded HH:MM:SS', () => {
    assert.strictEqual(
      formatSessionDuration('2026-09-02T10:05:23.881Z', '2026-09-02T11:05:05.438Z'),
      '00:59:41'
    );
  });

  test('end before start (session row after trip end) → unknown', () => {
    assert.strictEqual(
      formatSessionDuration('2026-09-02T11:05:05.438Z', '2026-09-02T10:05:23.881Z'),
      'unknown'
    );
  });

  test('missing end bound → unknown', () => {
    assert.strictEqual(formatSessionDuration('2026-09-02T10:05:23.881Z', null), 'unknown');
    assert.strictEqual(formatSessionDuration('2026-09-02T10:05:23.881Z', undefined), 'unknown');
  });

  test('missing both bounds → unknown', () => {
    assert.strictEqual(formatSessionDuration(null, undefined), 'unknown');
    assert.strictEqual(formatSessionDuration(undefined, null), 'unknown');
  });

  test('exactly one hour pads to 01:00:00', () => {
    assert.strictEqual(
      formatSessionDuration('2026-09-02T10:00:00.000Z', '2026-09-02T11:00:00.000Z'),
      '01:00:00'
    );
  });

  test('multi-hour span → HH:MM:SS shape', () => {
    assert.strictEqual(
      formatSessionDuration('2026-09-02T08:00:00.000Z', '2026-09-02T10:03:04.000Z'),
      '02:03:04'
    );
  });
});

// ── streamEvents finish-reason capture (REAL parser over ReadableStream) ──
// plans/088: budget exhaustion is silent failure unless the terminal reason
// survives the parser. Drives the real async generator with provider-shaped
// SSE bodies (TextEncoder chunks in a global ReadableStream — no simulation,
// unlike the 'stream [DONE] exit logic' suite above).

describe('streamEvents finish-reason capture', () => {
  function sseBody(chunks) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return { body };
  }

  async function collectEvents(chunks) {
    const events = [];
    for await (const evt of streamEvents(sseBody(chunks))) {
      events.push(evt);
    }
    return events;
  }

  const openAILength = [
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
    'data: [DONE]\n',
  ];

  test('OpenAI finish_reason "length" → exactly one finish event, yielded before done', async () => {
    const events = await collectEvents(openAILength);
    const finishes = events.filter((e) => e.type === 'finish');
    assert.strictEqual(finishes.length, 1, 'exactly one finish event');
    assert.strictEqual(finishes[0].type, 'finish');
    assert.strictEqual(finishes[0].reason, 'length');
    assert.strictEqual(events[events.length - 1].type, 'finish', 'finish is the last event before done');
    assert.strictEqual(finishes[0].text, undefined, 'finish event carries no text');
  });

  test('OpenAI finish_reason "stop" (normal completion) → finish event with reason stop', async () => {
    const events = await collectEvents([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    ]);
    const finishes = events.filter((e) => e.type === 'finish');
    assert.strictEqual(finishes.length, 1);
    assert.strictEqual(finishes[0].reason, 'stop');
  });

  test('Anthropic message_delta stop_reason "max_tokens" → finish event with reason max_tokens', async () => {
    const events = await collectEvents([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial answer"}}\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null}}\n',
    ]);
    const finishes = events.filter((e) => e.type === 'finish');
    assert.strictEqual(finishes.length, 1);
    assert.strictEqual(finishes[0].reason, 'max_tokens');
  });

  test('abrupt close with no terminal chunk → no finish event', async () => {
    const events = await collectEvents([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n',
    ]);
    assert.strictEqual(events.filter((e) => e.type === 'finish').length, 0);
    assert.deepStrictEqual(events.map((e) => e.type), ['content']);
  });

  test('text chunks still flow as content/reasoning alongside a finish event', async () => {
    const events = await collectEvents(openAILength);
    assert.deepStrictEqual(events.map((e) => e.type), ['content', 'reasoning', 'finish']);
    assert.strictEqual(events[0].text, 'Hello');
    assert.strictEqual(events[1].text, 'think');
  });

  test('finish_reason repeated across chunks → finish emitted only once', async () => {
    // Defensive: a provider may repeat a truthy finish_reason (final content
    // chunk + terminal empty chunk). The emittedFinish gate must collapse them.
    const events = await collectEvents([
      'data: {"choices":[{"delta":{"content":"tail"},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
      'data: [DONE]\n',
    ]);
    const finishes = events.filter((e) => e.type === 'finish');
    assert.strictEqual(finishes.length, 1);
    assert.strictEqual(finishes[0].reason, 'length');
    // Content chunk still flowed before the single finish event.
    assert.deepStrictEqual(events.map((e) => e.type), ['content', 'finish']);
  });
});

// ── Connectivity-gap forensics (REAL helpers from lib/llmPrompt) ───────────
// plans/089: the AI prompt must be told when telemetry is MISSING (upload
// backfill gaps / bursts) so the model stops diagnosing the discontinuity
// as an engine stall or sensor dropout. Helpers are pure — no mocks needed.
// A uniform 1 Hz session (the session-76 profile) must yield NO note, so the
// prompt stays byte-identical for clean trips.

describe('detectBackfillGaps', () => {
  // Minute-aligned base instant keeps per-minute bucketing deterministic.
  const T0 = Date.parse('2026-09-02T10:00:00.000Z');
  const iso = (ms) => new Date(T0 + ms).toISOString();

  // Uniform 1 Hz series (optionally split into 10-row segments with a dead
  // `gapSeconds` silence between them — absolute offsets so intervals are exact).
  function seriesWithGaps(gapSecondsList) {
    const offsets = [];
    let start = 0;
    for (const gapSeconds of gapSecondsList) {
      for (let i = 0; i < 10; i++) offsets.push(start + i * 1000);
      start += 9 * 1000 + gapSeconds * 1000; // last row at start+9s, then the gap
    }
    for (let i = 0; i < 10; i++) offsets.push(start + i * 1000);
    return offsets.map(iso);
  }

  test('uniform 1 Hz series → no gaps, ~60 rows/min (session-76 profile)', () => {
    const timestamps = [];
    for (let i = 0; i < 120; i++) timestamps.push(iso(i * 1000));
    const result = detectBackfillGaps(timestamps);
    assert.deepStrictEqual(result.gaps, []);
    assert.strictEqual(result.maxRowsInMinute, 60);
  });

  test('single 45s hole mid-series → one gap of 45s', () => {
    const offsets = [];
    for (let i = 0; i < 30; i++) offsets.push(i * 1000); // 0..29s
    for (let i = 0; i < 30; i++) offsets.push(29 * 1000 + 45 * 1000 + i * 1000); // resumes at 74s
    const result = detectBackfillGaps(offsets.map(iso));
    assert.strictEqual(result.gaps.length, 1);
    assert.strictEqual(result.gaps[0].seconds, 45);
    assert.strictEqual(result.gaps[0].startIso, iso(29 * 1000));
    assert.strictEqual(result.gaps[0].endIso, iso(74 * 1000));
  });

  test('120 rows in a single minute → burst detected, no gaps', () => {
    const timestamps = [];
    for (let i = 0; i < 120; i++) timestamps.push(iso(i * 500)); // 2 Hz flush, all < 60s
    const result = detectBackfillGaps(timestamps);
    assert.deepStrictEqual(result.gaps, []);
    assert.strictEqual(result.maxRowsInMinute, 120);
  });

  test('4s sub-threshold hole → NOT a gap', () => {
    const offsets = [];
    for (let i = 0; i < 30; i++) offsets.push(i * 1000); // 0..29s
    for (let i = 0; i < 30; i++) offsets.push(29 * 1000 + 4 * 1000 + i * 1000); // resumes at 33s
    const result = detectBackfillGaps(offsets.map(iso));
    assert.deepStrictEqual(result.gaps, []);
  });

  test('unsorted input → same result as sorted (sorts internally)', () => {
    const sorted = [];
    for (let i = 0; i < 120; i++) sorted.push(iso(i * 1000));
    const reversed = [...sorted].reverse();
    assert.deepStrictEqual(detectBackfillGaps(reversed), detectBackfillGaps(sorted));
    assert.deepStrictEqual(detectBackfillGaps(reversed).gaps, []);
  });

  test('empty array → no gaps, zero burst', () => {
    assert.deepStrictEqual(detectBackfillGaps([]), { gaps: [], maxRowsInMinute: 0 });
  });

  test('>3 gaps → capped at the 3 longest', () => {
    const result = detectBackfillGaps(seriesWithGaps([6, 20, 10, 30, 15]));
    assert.strictEqual(result.gaps.length, 3);
    assert.deepStrictEqual(result.gaps.map(g => g.seconds), [30, 20, 15]);
  });
});

describe('buildDataQualityNote', () => {
  const gap45 = { startIso: '2026-09-02T10:00:29.000Z', endIso: '2026-09-02T10:01:14.000Z', seconds: 45 };

  test('null input → null', () => {
    assert.strictEqual(buildDataQualityNote(null), null);
    assert.strictEqual(buildDataQualityNote(undefined), null);
  });

  test('no gaps + no burst → null', () => {
    assert.strictEqual(buildDataQualityNote({ gaps: [], maxRowsInMinute: 60 }), null);
  });

  test('gap-only → mentions Connectivity gap and NOT an engine stall', () => {
    const note = buildDataQualityNote({ gaps: [gap45], maxRowsInMinute: 40 });
    assert.ok(note.includes('Connectivity gap'), note);
    assert.ok(note.includes('NOT an engine stall'), note);
    assert.ok(note.includes('45s (ends 10:01:14Z)'), note);
    assert.ok(!note.includes('Backfill burst'), note);
  });

  test('burst-only → mentions Backfill burst', () => {
    const note = buildDataQualityNote({ gaps: [], maxRowsInMinute: 120 });
    assert.ok(note.includes('Backfill burst'), note);
    assert.ok(!note.includes('Connectivity gap'), note);
  });

  test('both gaps and burst present → both sentences present', () => {
    const note = buildDataQualityNote({ gaps: [gap45], maxRowsInMinute: 120 });
    assert.ok(note.includes('Connectivity gap'), note);
    assert.ok(note.includes('NOT an engine stall'), note);
    assert.ok(note.includes('Backfill burst'), note);
  });
});

// ── Analysis prework in SQL (plans/014) ────────────────────────────────────
// The controller now derives gap/peak stats and the evenly-spaced id list in
// SQL. detectBackfillGaps() remains the behavioral spec, so fixtures here are
// hand-computed (never generated by the pure fn) and then cross-checked
// against the pure fn on the same timestamps.

// Inject a models stub before requiring the controller so no real Sequelize
// instance or DB connection is built.
const preworkQueryCalls = [];
let preworkQueryHandler = async () => [];
// Mutable fixtures for the analyzeSession lifecycle suite (plans/012). The
// controller is required once below, so its models deps must be programmable
// from here rather than re-stubbed per test.
const lifecycle = {
  session: null,
  sample: [],
  created: [],
  // When set, Session.findOne only resolves for this userId — lets tests
  // exercise the ownership-first 404 path with the single-flight slot held.
  ownerUserId: null,
};
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: {
    Session: {
      findOne: async (opts) => {
        const owner = lifecycle.ownerUserId;
        // Ownership scoping is what makes the 404-vs-409 ordering testable.
        if (owner != null && opts?.where?.userId !== owner) return null;
        return lifecycle.session;
      },
    },
    Log: { findAll: async () => lifecycle.sample },
    Analysis: { create: async (row) => { lifecycle.created.push(row); return row; } },
    Vehicle: {},
    Settings: {
      getSingleton: async () => ({
        llmProvider: 'openai', llmModel: 'test-model', llmApiKeyEnc: 'encrypted-key',
      }),
    },
    sequelize: {
      query: async (sql, opts) => {
        preworkQueryCalls.push({ sql, opts });
        return preworkQueryHandler(sql, opts);
      },
      QueryTypes: { SELECT: 'SELECT' },
    },
  },
};

// The controller destructures analyze/streamEvents at require time, so the
// provider module must be stubbed before that require. The real providers were
// already loaded above (line ~36) for their own suites and keep working there.
const llmProvidersPath = require.resolve('../lib/llmProviders');
const llmStubs = {
  analyze: async () => { throw new Error('llm analyze stub not installed'); },
  streamEvents: async function* () {
    yield* []; // never reached: callers install a real stream generator
    throw new Error('llm streamEvents stub not installed');
  },
};
require.cache[llmProvidersPath] = {
  id: llmProvidersPath,
  filename: llmProvidersPath,
  loaded: true,
  exports: {
    analyze: (...args) => llmStubs.analyze(...args),
    streamEvents: (...args) => llmStubs.streamEvents(...args),
  },
};

const AnalysisController = require('../controllers/AnalysisController');

describe('computeGapSummary (SQL gap/peak parity)', () => {
  const T0 = Date.parse('2026-09-02T10:00:00.000Z');
  const iso = (ms) => new Date(T0 + ms).toISOString();

  function drive(rows) {
    preworkQueryCalls.length = 0;
    preworkQueryHandler = async () => rows;
    return AnalysisController.computeGapSummary(1);
  }

  test('two gaps: longest-first, ISO bounds exact, peak from per-minute max', async () => {
    // 0..9s, 21..30s (12s hole), 74..79s (44s hole) — 26 rows.
    // Per-minute by hand: minute 0 has 10 + 10 = 20 rows, minute 1 has 6 → 20.
    const timestamps = [];
    for (let i = 0; i <= 9; i++) timestamps.push(iso(i * 1000));
    for (let i = 21; i <= 30; i++) timestamps.push(iso(i * 1000));
    for (let i = 74; i <= 79; i++) timestamps.push(iso(i * 1000));

    const summary = await drive([
      // chronological from the CTE, peak last (NULLS LAST)
      { kind: 'gap', gap_start: new Date(iso(9000)), gap_end: new Date(iso(21000)), seconds: 12, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(30000)), gap_end: new Date(iso(74000)), seconds: 44, cnt: null },
      { kind: 'peak', gap_start: null, gap_end: null, seconds: null, cnt: '20' },
    ]);

    const expected = [
      { startIso: iso(30000), endIso: iso(74000), seconds: 44 },
      { startIso: iso(9000), endIso: iso(21000), seconds: 12 },
    ];
    assert.deepStrictEqual(summary.gaps, expected);
    assert.strictEqual(summary.maxRowsInMinute, 20);
    assert.deepStrictEqual(summary.gaps, detectBackfillGaps(timestamps).gaps);
    assert.strictEqual(summary.maxRowsInMinute, detectBackfillGaps(timestamps).maxRowsInMinute);
  });

  test('>3 gaps → three longest kept, ties in the pure fn\'s chronological order', async () => {
    // Segments of 10 rows at 1 Hz, holes of 6/20/10/30/15 s between them.
    // Offsets by hand: 0-9, 15-24, 44-53, 63-72, 102-111, 126-135.
    const timestamps = [];
    for (const base of [0, 15, 44, 63, 102, 126]) {
      for (let i = 0; i <= 9; i++) timestamps.push(iso((base + i) * 1000));
    }
    // Minute 0 holds 30 rows (0-9, 15-24, 44-53) → peak.
    const summary = await drive([
      { kind: 'gap', gap_start: new Date(iso(9000)), gap_end: new Date(iso(15000)), seconds: 6, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(24000)), gap_end: new Date(iso(44000)), seconds: 20, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(53000)), gap_end: new Date(iso(63000)), seconds: 10, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(72000)), gap_end: new Date(iso(102000)), seconds: 30, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(111000)), gap_end: new Date(iso(126000)), seconds: 15, cnt: null },
      { kind: 'peak', gap_start: null, gap_end: null, seconds: null, cnt: '30' },
    ]);

    assert.deepStrictEqual(summary.gaps.map(g => g.seconds), [30, 20, 15]);
    assert.deepStrictEqual(summary.gaps.map(g => g.startIso), [iso(72000), iso(24000), iso(111000)]);
    assert.strictEqual(summary.maxRowsInMinute, 30);
    assert.deepStrictEqual(summary.gaps, detectBackfillGaps(timestamps).gaps);
    assert.strictEqual(summary.maxRowsInMinute, detectBackfillGaps(timestamps).maxRowsInMinute);
  });

  test('empty session → no gaps, maxRowsInMinute 0 (NULL peak row)', async () => {
    const summary = await drive([
      { kind: 'peak', gap_start: null, gap_end: null, seconds: null, cnt: null },
    ]);
    assert.deepStrictEqual(summary, detectBackfillGaps([]));
    assert.deepStrictEqual(summary, { gaps: [], maxRowsInMinute: 0 });
  });

  test('single-row session → peak of 1, no gaps', async () => {
    const timestamps = [iso(0)];
    const summary = await drive([
      { kind: 'peak', gap_start: null, gap_end: null, seconds: null, cnt: '1' },
    ]);
    assert.deepStrictEqual(summary, { gaps: [], maxRowsInMinute: 1 });
    assert.deepStrictEqual(summary, detectBackfillGaps(timestamps));
  });

  test('5.4s fractional gap rounds to 5 whole seconds in the summary', async () => {
    // The fixture supplies the kept gap row directly; the >=5s predicate is
    // pinned separately by the threshold test below. Rows at 0s and 5.4s make
    // the parity cross-check meaningful for fractional seconds.
    const timestamps = [iso(0), iso(5400)];
    const summary = await drive([
      { kind: 'gap', gap_start: new Date(iso(0)), gap_end: new Date(iso(5400)), seconds: 5.4, cnt: null },
      { kind: 'peak', gap_start: null, gap_end: null, seconds: null, cnt: '2' },
    ]);
    assert.deepStrictEqual(summary, {
      gaps: [{ startIso: iso(0), endIso: iso(5400), seconds: 5 }],
      maxRowsInMinute: 2,
    });
    assert.deepStrictEqual(summary, detectBackfillGaps(timestamps));
  });

  test('transfer is bounded: LIMIT :maxGaps = 3 and only 3 rows reach JS', async () => {
    // Five candidate gaps in the fixture: even if the driver hands back more
    // than SQL would ship, the summary can never exceed MAX_REPORTED_GAPS.
    const summary = await drive([
      { kind: 'gap', gap_start: new Date(iso(9000)), gap_end: new Date(iso(15000)), seconds: 6, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(24000)), gap_end: new Date(iso(44000)), seconds: 20, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(53000)), gap_end: new Date(iso(63000)), seconds: 10, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(72000)), gap_end: new Date(iso(102000)), seconds: 30, cnt: null },
      { kind: 'gap', gap_start: new Date(iso(111000)), gap_end: new Date(iso(126000)), seconds: 15, cnt: null },
      { kind: 'peak', gap_start: null, gap_end: null, seconds: null, cnt: '30' },
    ]);

    assert.strictEqual(summary.gaps.length, 3);
    assert.deepStrictEqual(summary.gaps.map(g => g.seconds), [30, 20, 15]);

    const { sql, opts } = preworkQueryCalls[0];
    assert.match(sql, /LIMIT :maxGaps/);
    assert.strictEqual(opts.replacements.maxGaps, 3);
    // Rounding inside ORDER BY is what keeps ties aligned with the pure fn.
    assert.match(sql, /ORDER BY\s+ROUND\([^)]*\)\s+DESC\s*,\s*gap_start\s+ASC/);
  });

  test('gap and minute CTEs share one MATERIALIZED scan of Logs', async () => {
    await drive([]);
    const { sql } = preworkQueryCalls[0];
    assert.match(sql, /WITH base AS MATERIALIZED \(\s*SELECT "timestamp" FROM "Logs" WHERE "sessionId" = :sessionId\s*\)/);
    assert.strictEqual((sql.match(/FROM "Logs"/g) || []).length, 1, sql);
    assert.match(sql, /FROM base\s*\)\s*,\s*gap_rows AS \(/);
    assert.match(sql, /FROM base\s+GROUP BY 1/);
  });

  test('threshold comes from GAP_ANALYSIS.MIN_GAP_SECONDS as a numeric predicate', async () => {
    await drive([]);
    assert.strictEqual(preworkQueryCalls.length, 1);
    const { sql, opts } = preworkQueryCalls[0];
    assert.strictEqual(opts.replacements.minGapSeconds, 5);
    assert.ok(sql.includes('EXTRACT(EPOCH FROM curr_ts - prev_ts) >= :minGapSeconds'), sql);
    assert.ok(sql.includes("date_trunc('minute'"), sql);
    assert.ok(sql.includes('MAX(cnt)'), sql);
    assert.strictEqual(opts.type, 'SELECT');
  });
});

describe('selectEvenIds (SQL stride parity)', () => {
  // The removed JS loop: target = min(100, ids.length);
  // step = max(1, floor(ids.length / target)); take ids[0], ids[step], …
  function legacyPick(ids) {
    const target = Math.min(100, ids.length);
    const step = Math.max(1, Math.floor(ids.length / target));
    const picked = [];
    for (let i = 0; i < ids.length && picked.length < target; i += step) picked.push(ids[i]);
    return picked;
  }

  function range(n) {
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  function drive(ids, total) {
    preworkQueryCalls.length = 0;
    preworkQueryHandler = async (sql) => (
      sql.includes('ROW_NUMBER()') ? ids.map(id => ({ id })) : []
    );
    return AnalysisController.selectEvenIds(1, total);
  }

  test('total=120 → stride 1, first 100 ids (LIMIT caps the 120 matches)', async () => {
    const all = range(120);
    const picked = await drive(all.slice(0, 100), 120);
    assert.deepStrictEqual(picked, all.slice(0, 100));
    assert.deepStrictEqual(picked, legacyPick(all));
    const { sql, opts } = preworkQueryCalls[0];
    assert.strictEqual(opts.replacements.stride, 1);
    assert.strictEqual(opts.replacements.target, 100);
    assert.ok(sql.includes('LIMIT :target'), sql);
  });

  test('total=1000 → stride 10, ids 1,11,…,991', async () => {
    const all = range(1000);
    const expected = all.filter((_, i) => i % 10 === 0); // 100 ids
    const picked = await drive(expected, 1000);
    assert.strictEqual(picked.length, 100);
    assert.strictEqual(picked[0], 1);
    assert.strictEqual(picked[99], 991);
    assert.deepStrictEqual(picked, expected);
    assert.deepStrictEqual(picked, legacyPick(all));
  });

  test('total=401 → stride 4, 101 candidates trimmed to 100 (last id 397)', async () => {
    const all = range(401);
    const expected = legacyPick(all);
    const picked = await drive(expected, 401);
    assert.strictEqual(picked.length, 100);
    assert.deepStrictEqual(picked, expected);
    assert.strictEqual(picked[picked.length - 1], 397);
  });

  test('total=0 → no query, empty middle slice', async () => {
    const picked = await drive([], 0);
    assert.deepStrictEqual(picked, []);
    assert.strictEqual(preworkQueryCalls.length, 0);
  });
});

describe('analysis prework: no full-session scans remain', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'AnalysisController.js'), 'utf8'
  );

  // Style-agnostic invariants: quoting/spacing/newlines may change, the
  // session scoping and bounding may not.
  test('every timestamp read of Logs is session-scoped', () => {
    const reads = [...src.matchAll(/SELECT\s+"?timestamp"?\s+FROM\s+"?Logs"?/gi)];
    assert.ok(reads.length > 0, 'expected at least one bounded timestamp read');
    for (const read of reads) {
      const tail = src.slice(read.index, read.index + 200);
      assert.match(
        tail,
        /"sessionId"\s*=\s*:sessionId/,
        `unscoped timestamp read: ${tail.split('\n')[0]}`
      );
    }
  });

  test('no unbounded id scan remains', () => {
    assert.doesNotMatch(src, /SELECT\s+"?id"?\s+FROM\s+"?Logs"?/i);
  });

  test('ranked, session-scoped selector present', () => {
    assert.match(src, /FROM "Logs"\s+WHERE "sessionId" = :sessionId\s*\)\s*ranked/);
  });
});

// ── Analysis lifecycle (plans/012) ─────────────────────────────────────────

describe('analyzeSession single-flight guard', () => {
  /** res double: records SSE frames + terminal state. */
  function makeRes() {
    const res = {
      statusCode: 200,
      headersSent: false,
      headers: {},
      chunks: [],
      ended: false,
      setHeader(key, value) { res.headers[key] = value; },
      flushHeaders() { res.headersSent = true; },
      status(code) { res.statusCode = code; return res; },
      json(body) { res.body = body; return res; },
      write(chunk) { res.chunks.push(String(chunk)); return true; },
      end() { res.ended = true; },
    };
    return res;
  }

  /** req double: `emitClose` drives the controller's `req.on('close')`. */
  function makeReq(sessionId) {
    const listeners = {};
    return {
      user: { id: 1 },
      params: { sessionId: String(sessionId) },
      query: {},
      body: {},
      on(event, cb) { listeners[event] = cb; },
      emitClose() { if (listeners.close) listeners.close(); },
    };
  }

  function installSession(sessionId) {
    lifecycle.session = {
      id: sessionId,
      firstTimestamp: new Date('2026-10-01T10:00:00.000Z'),
      lastTimestamp: new Date('2026-10-01T10:01:00.000Z'),
      toJSON: () => ({ id: sessionId, name: 'Lifecycle session', vehicleId: null }),
    };
    lifecycle.sample = [{
      timestamp: new Date('2026-10-01T10:00:00.000Z'),
      lat: 1, lon: 2, engine_rpm: 900, vehicle_speed: 0, values: {},
    }];
  }

  function installQueries() {
    preworkQueryHandler = async (sql) => {
      if (sql.includes('jsonb_object_keys')) return [[]];
      if (sql.includes('MIN("timestamp")')) {
        return [[{
          startTs: new Date('2026-10-01T10:00:00.000Z'),
          endTs: new Date('2026-10-01T10:01:00.000Z'),
        }]];
      }
      if (sql.includes('COUNT(*)')) return [[{ cnt: '1' }]];
      return [];
    };
  }

  function installAnalyze() {
    llmStubs.analyze = async () => ({
      response: {},
      abortController: { abort() {} },
      timeoutGuard: { bump() {}, clear() {} },
    });
  }

  function reset(sessionId) {
    lifecycle.created = [];
    lifecycle.ownerUserId = null;
    installSession(sessionId);
    installQueries();
    installAnalyze();
  }

  /** Drain pending microtasks/macrotasks so an in-progress request has
   *  passed its awaits (ownership lookup) before the next request starts. */
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  test('second concurrent request for the same session → 409, first still completes', async () => {
    reset(101);
    lifecycle.ownerUserId = 1;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    llmStubs.streamEvents = async function* () {
      yield { type: 'content', text: 'a' };
      await gate;
      yield { type: 'content', text: 'b' };
    };

    const res1 = makeRes();
    const first = AnalysisController.analyzeSession(makeReq(101), res1);
    // The guard is acquired right after the ownership lookup resolves, so the
    // owner must be past that await before the duplicate arrives.
    await flush();
    const res2 = makeRes();
    await AnalysisController.analyzeSession(makeReq(101), res2);

    assert.strictEqual(res2.statusCode, 409);
    assert.deepStrictEqual(res2.body, { error: 'Analysis already running for this session.' });

    release();
    await first;

    assert.ok(res1.chunks.includes('data: [DONE]\n\n'), res1.chunks.join(''));
    assert.strictEqual(lifecycle.created.length, 1);
    assert.strictEqual(lifecycle.created[0].response, 'ab');
  });

  test('non-owner request while the owner is running → 404, not a 409 oracle', async () => {
    reset(104);
    lifecycle.ownerUserId = 1; // makeReq() authenticates as user 1
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    llmStubs.streamEvents = async function* () {
      yield { type: 'content', text: 'a' };
      await gate;
      yield { type: 'content', text: 'b' };
    };

    const res1 = makeRes();
    const first = AnalysisController.analyzeSession(makeReq(104), res1);
    await flush(); // owner now holds the single-flight slot for 104

    const intruderRes = makeRes();
    const intruderReq = makeReq(104);
    intruderReq.user = { id: 2 };
    await AnalysisController.analyzeSession(intruderReq, intruderRes);

    // The slot is busy, but a non-owner must learn nothing about it.
    assert.strictEqual(intruderRes.statusCode, 404);
    assert.deepStrictEqual(intruderRes.body, { error: 'Session not found' });
    assert.notStrictEqual(intruderRes.statusCode, 409);

    release();
    await first;
    assert.strictEqual(res1.statusCode, 200);
    assert.ok(res1.chunks.includes('data: [DONE]\n\n'), res1.chunks.join(''));
  });

  test('guard clears after a thrown stream → same session can retry', async () => {
    reset(102);
    llmStubs.streamEvents = async function* () {
      yield { type: 'content', text: 'partial' };
      throw new Error('provider stream died');
    };

    await AnalysisController.analyzeSession(makeReq(102), makeRes());
    // The failed run persisted its partial output and released the slot.
    assert.strictEqual(lifecycle.created.length, 1);

    llmStubs.streamEvents = async function* () {
      yield { type: 'content', text: 'retry ok' };
    };
    const retryRes = makeRes();
    await AnalysisController.analyzeSession(makeReq(102), retryRes);

    assert.notStrictEqual(retryRes.statusCode, 409);
    assert.ok(retryRes.chunks.includes('data: [DONE]\n\n'), retryRes.chunks.join(''));
    assert.strictEqual(lifecycle.created.length, 2);
    assert.strictEqual(lifecycle.created[1].response, 'retry ok');
    assert.strictEqual(lifecycle.created[1].tokenUsage, null);
  });

  test('client close mid-stream persists the partial answer with tokenUsage.aborted', async () => {
    reset(103);
    const req = makeReq(103);
    llmStubs.streamEvents = async function* () {
      yield { type: 'content', text: 'partial answer' };
      req.emitClose();
      throw new Error('aborted');
    };

    await AnalysisController.analyzeSession(req, makeRes());

    assert.strictEqual(lifecycle.created.length, 1);
    const row = lifecycle.created[0];
    assert.strictEqual(row.response, 'partial answer');
    assert.strictEqual(row.reasoning, null);
    assert.deepStrictEqual(row.tokenUsage, {
      aborted: true,
      responseChars: 'partial answer'.length,
      reasoningChars: 0,
    });
  });

  test('client close before any chunk persists no row', async () => {
    reset(104);
    const req = makeReq(104);
    llmStubs.streamEvents = async function* () {
      yield* []; // no chunk ever arrives before the disconnect
      req.emitClose();
      throw new Error('aborted');
    };

    const res = makeRes();
    await AnalysisController.analyzeSession(req, res);

    assert.strictEqual(lifecycle.created.length, 0);
    assert.ok(!res.chunks.includes('data: [DONE]\n\n'));
  });
});

describe('exportAnalyses backpressure (plans/012)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'AnalysisController.js'), 'utf8'
  );

  test('row writes await drain via the exportCsv idiom (exactly one listener site)', () => {
    // Only the helper may register the listener: one site means every chunk
    // goes through the same guard, and a second ad-hoc write would fail here.
    const drains = [...src.matchAll(/res\.once\('drain'/g)];
    assert.strictEqual(drains.length, 1, src.match(/.*res\.once\('drain'.*/)?.[0]);
    assert.match(
      src,
      /if \(!res\.write\(chunk\)\) \{\s*await new Promise\(resolve => res\.once\('drain', resolve\)\);/,
    );
  });

  test('the export loop no longer writes rows unchecked', () => {
    const exportBody = src.slice(src.indexOf('static async exportAnalyses'));
    const loop = exportBody.slice(
      exportBody.indexOf('for (const a of batch)'),
      exportBody.indexOf('if (batch.length < BATCH)')
    );
    assert.ok(!/res\.write\(/.test(loop), loop);
    assert.match(loop, /await writeChunk\(/);
  });
});

