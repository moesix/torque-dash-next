'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { getBaseUrl, PROVIDERS } = require('../lib/llmProviders');

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

// ── Sampling logic (pure JS) ───────────────────────────────────────────────

describe('keyset-based sampling', () => {
  function sampleIds(ids, sampleSize = 100) {
    const step = Math.max(1, Math.floor(ids.length / sampleSize));
    return ids.filter((_, i) => i % step === 0).slice(0, sampleSize);
  }

  test('1000 ids → produces exactly 100 sampled ids', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    const sampled = sampleIds(ids);
    assert.strictEqual(sampled.length, 100);
  });

  test('sampled ids are evenly spaced', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    const sampled = sampleIds(ids);
    // Step should be 10 (1000/100)
    assert.strictEqual(sampled[0], 1);
    assert.strictEqual(sampled[1], 11);
    assert.strictEqual(sampled[2], 21);
    assert.strictEqual(sampled[99], 991);
  });

  test('50 ids → returns all 50 (under sampleSize)', () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const sampled = sampleIds(ids);
    assert.strictEqual(sampled.length, 50);
    assert.deepStrictEqual(sampled, ids);
  });

  test('1 id → returns 1', () => {
    const sampled = sampleIds([42]);
    assert.strictEqual(sampled.length, 1);
    assert.strictEqual(sampled[0], 42);
  });

  test('0 ids → returns empty', () => {
    const sampled = sampleIds([]);
    assert.strictEqual(sampled.length, 0);
  });

  test('200 ids → produces 100 sampled ids', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const sampled = sampleIds(ids);
    assert.strictEqual(sampled.length, 100);
    // Step should be 2
    assert.strictEqual(sampled[0], 1);
    assert.strictEqual(sampled[1], 3);
    assert.strictEqual(sampled[2], 5);
  });

  test('300 ids → produces 100 sampled ids at step 3', () => {
    const ids = Array.from({ length: 300 }, (_, i) => i + 1);
    const sampled = sampleIds(ids);
    assert.strictEqual(sampled.length, 100);
    assert.strictEqual(sampled[0], 1);
    assert.strictEqual(sampled[1], 4);
    assert.strictEqual(sampled[2], 7);
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
