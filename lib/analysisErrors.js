'use strict';

// ── Error classification for AI analysis streams (plans/086) ───────────────
// Maps provider / transport errors into client-safe, actionable messages.
// Pure function — no model imports, safe to require in tests without DATABASE_URL.

function classifyAnalysisError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not configured/i.test(msg)) {
    return 'AI provider is not fully configured — add an API key in Settings.';
  }
  if (/API error (\d{3})/i.test(msg)) {
    const m = msg.match(/API error (\d{3})/i);
    const status = m && Number(m[1]);
    if (status === 401 || status === 403) {
      return 'AI provider rejected the API key. Check the key in Settings.';
    }
    if (status === 429) {
      return 'AI provider rate limit reached. Wait a moment and retry.';
    }
    return `AI provider error (${status}). Try again or lower reasoning effort.`;
  }
  return 'Analysis failed. Please try again.';
}

module.exports = { classifyAnalysisError };
