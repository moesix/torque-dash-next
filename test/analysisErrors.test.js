'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the real classifier from the pure utility file — house rule B-06: no local copies.
const { classifyAnalysisError } = require('../lib/analysisErrors');

describe('classifyAnalysisError', () => {
  test('not-configured → Settings message', () => {
    const msg = classifyAnalysisError(new Error('API key not configured'));
    assert.match(msg, /Settings/i);
    assert.match(msg, /API key/i);
  });

  test('LLM API error 401 → key-rejected message', () => {
    const msg = classifyAnalysisError(new Error('LLM API error 401: {"error":"invalid_api_key"}'));
    assert.match(msg, /key/i);
    assert.match(msg, /Settings/i);
  });

  test('LLM API error 403 → key-rejected message', () => {
    const msg = classifyAnalysisError(new Error('LLM API error 403: forbidden'));
    assert.match(msg, /key/i);
    assert.match(msg, /Settings/i);
  });

  test('LLM API error 429 → rate-limit message', () => {
    const msg = classifyAnalysisError(new Error('LLM API error 429: rate limited'));
    assert.match(msg, /rate limit/i);
  });

  test('LLM API error 503 → generic provider error with status', () => {
    const msg = classifyAnalysisError(new Error('LLM API error 503: overloaded'));
    assert.match(msg, /503/i);
    assert.match(msg, /try again/i);
  });

  test('Anthropic API error → generic provider error with status', () => {
    const msg = classifyAnalysisError(new Error('Anthropic API error 500: server error'));
    assert.match(msg, /500/i);
    assert.match(msg, /try again/i);
  });

  test('AbortError (provider stall) → generic retry message', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const msg = classifyAnalysisError(err);
    assert.match(msg, /try again/i);
  });

  test('unknown error → fallback message', () => {
    const msg = classifyAnalysisError(new Error('something unexpected'));
    assert.match(msg, /try again/i);
  });

  test('non-Error input → fallback message', () => {
    const msg = classifyAnalysisError('boom');
    assert.match(msg, /try again/i);
  });
});
