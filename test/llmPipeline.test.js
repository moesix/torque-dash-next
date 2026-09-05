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

