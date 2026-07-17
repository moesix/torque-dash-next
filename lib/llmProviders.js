const { encrypt, decrypt } = require('./encryption');
const { isSafeUrl } = require('./ssrfGuard');

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-nano'],
    defaultModel: 'gpt-4o-mini',
  },
  anthropic: {
    name: 'Anthropic',
    models: ['claude-sonnet-4-20250514', 'claude-3.5-haiku'],
    defaultModel: 'claude-3.5-haiku',
  },
  ollama: {
    name: 'Ollama (Local)',
    models: ['llama3.1', 'mistral', 'codellama'],
    defaultModel: 'llama3.1',
  },
  custom: {
    name: 'Custom (OpenAI-compatible)',
    models: [],
    defaultModel: '',
  },
};

function getApiKey(settings) {
  if (!settings.llmApiKeyEnc) return null;
  return decrypt(settings.llmApiKeyEnc);
}

function prepareApiKey(key) {
  if (!key || typeof key !== 'string') return null;
  return encrypt(key);
}

function getBaseUrl(settings) {
  if (settings.llmEndpoint) return settings.llmEndpoint;
  switch (settings.llmProvider) {
    case 'openai': return 'https://api.openai.com/v1';
    case 'anthropic': return null;
    case 'ollama': return 'http://localhost:11434/v1';
    case 'custom': return settings.llmEndpoint || '';
    default: return null;
  }
}

async function analyzeOpenAICompatible(prompt, settings, options = {}) {
  const apiKey = getApiKey(settings);
  const baseUrl = getBaseUrl(settings);
  const model = options.model || settings.llmModel || PROVIDERS[settings.llmProvider]?.defaultModel;

  if (!apiKey) throw new Error('API key not configured');
  if (!baseUrl) throw new Error('Endpoint not configured');

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 120_000);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: options.maxTokens || 2048,
    }),
    signal: ac.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body}`);
  }

  return { response: res, abortController: ac };
}

async function analyzeAnthropic(prompt, settings, options = {}) {
  const apiKey = getApiKey(settings);
  const model = options.model || settings.llmModel || PROVIDERS.anthropic.defaultModel;

  if (!apiKey) throw new Error('API key not configured');

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 120_000);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: options.maxTokens || 2048,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
    signal: ac.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  return { response: res, abortController: ac };
}

async function analyze(prompt, settings, options = {}) {
  const provider = settings.llmProvider;
  if (!provider || !PROVIDERS[provider]) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  // Validate custom endpoint for SSRF — all endpoints checked, but Ollama
  // is also allowed to use localhost/127.0.0.1 for local instances.
  if (settings.llmEndpoint) {
    const url = new URL(settings.llmEndpoint);
    const hostname = url.hostname;
    if (settings.llmProvider === 'ollama' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
      // Local Ollama instance is allowed
    } else {
      const safe = await isSafeUrl(settings.llmEndpoint);
      if (!safe) throw new Error('Endpoint URL failed safety validation');
    }
  }

  switch (provider) {
    case 'openai':
    case 'ollama':
    case 'custom':
      return analyzeOpenAICompatible(prompt, settings, options);
    case 'anthropic':
      return analyzeAnthropic(prompt, settings, options);
    default:
      throw new Error(`Provider not implemented: ${provider}`);
  }
}

module.exports = { PROVIDERS, analyze, prepareApiKey, getApiKey };
