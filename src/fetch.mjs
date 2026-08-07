/**
 * fetch.mjs — HTTP helpers with timeout and retry/backoff
 *
 * Shared by jobs.mjs, prune.mjs, check-liveness.mjs, ats.mjs.
 *
 * Retry policy: linear backoff (500ms × attempt). Permanent 4xx errors (except 429)
 * are NOT retried — they won't recover from waiting and would just waste wall-time.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

// True if the error represents a 4xx HTTP response other than 429 (rate-limit).
// 4xx = client error, won't be fixed by retrying. 429 = rate-limited, retry helps.
export function isPermanentError(err) {
  const m = /^HTTP (\d+)$/.exec(err?.message || '');
  if (!m) return false;
  const status = parseInt(m[1]);
  return status >= 400 && status < 500 && status !== 429;
}

export async function fetchWithTimeout(url, timeoutMs = 10_000, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

// Fetch JSON with up to `retries` retry attempts on failure (linear backoff: 500ms, 1s, 1.5s).
// Throws the last error if all attempts fail. Permanent 4xx errors fail fast.
export async function fetchJson(url, { timeoutMs = 10_000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (isPermanentError(e) || attempt >= retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Fetch raw HTML text with retries. For scrape-based adapters.
export async function fetchText(url, { timeoutMs = 10_000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (isPermanentError(e) || attempt >= retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// POST + JSON helper for ATS APIs that don't accept GET (e.g. Workday).
// Same retry semantics as fetchJson.
export async function postJson(url, body, { timeoutMs = 10_000, retries = 3, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (isPermanentError(e) || attempt >= retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Fetch raw response (no JSON parse) with retries. Used by prune for liveness checks
// where we only care about status codes / redirects — never throws on !ok status.
// Only retries on network errors / timeouts.
export async function fetchResponse(url, { timeoutMs = 10_000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}
