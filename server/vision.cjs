'use strict';

// Scope results to endpoint and credentials as well as model name. Retry
// failures shortly: a timeout or missing projector is not a model capability.
function createVisionProbe({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async (baseUrl, headers, model) => {
    const key = JSON.stringify([baseUrl, headers, model]);
    const cached = cache.get(key);
    if (cached && cached.until > now()) return cached.result;
    const url = `${String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let result;
    try {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: [
          { type: 'text', text: 'ok' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pixel}` } },
        ] }] }),
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) result = { supported: true, reason: null };
      else {
        const body = await response.text();
        const reason = /mmproj|projector/i.test(body)
          ? 'The inference server needs a multimodal projector (mmproj) configured.'
          : `The inference server rejected the image probe (HTTP ${response.status}). Check model configuration and server availability.`;
        result = { supported: false, reason };
      }
    } catch {
      result = { supported: false, reason: 'The image probe could not reach the inference server or timed out. Retry when the server is available.' };
    }
    cache.set(key, { result, until: now() + (result.supported ? 300000 : 30000) });
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return result;
  };
}

module.exports = { createVisionProbe };
