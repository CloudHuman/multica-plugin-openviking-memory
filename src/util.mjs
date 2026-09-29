import { createHash } from 'node:crypto';
import { renameSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Short deterministic hex digest used for OV account/user ids. */
export function shortHash(value, len = 12) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, len);
}

/** Clip a string to at most `max` characters, appending an ellipsis marker. */
export function cap(text, max) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 15)) + `…[truncated ${s.length - max + 15} chars]`;
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Atomic JSON write: temp file + rename, with 0600 perms for sensitive files. */
export function atomicWriteJson(path, value, { mode = 0o644 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, path);
}

export function readJsonIfExists(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nowIso() {
  return new Date().toISOString();
}

/** Slugify arbitrary text into a filesystem-safe memory file name fragment. */
export function slugify(text, max = 48) {
  const s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const clipped = s.slice(0, max).replace(/-+$/, '');
  return clipped || shortHash(String(text ?? Math.random()), 8);
}

/** Fetch JSON with timeout and envelope-aware error handling. */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    const e = new Error(`request failed: ${method} ${url}: ${err.message}`);
    e.code = 'NETWORK';
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const e = new Error(
      `HTTP ${res.status} ${method} ${url}: ${json?.error?.message ?? text?.slice(0, 300) ?? '(empty)'}`,
    );
    e.status = res.status;
    e.body = json;
    e.code = json?.error?.code ?? String(res.status);
    throw e;
  }
  return json;
}

/** Retry with exponential backoff for transient failures (network / 5xx / 429). */
export async function withRetry(fn, { attempts = 3, baseDelayMs = 1_000, factor = 3, jitter = 0.3, shouldRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const transient =
        err.code === 'NETWORK' || err.status === 429 || (err.status ?? 0) >= 500 || err.code === 'ETIMEDOUT';
      const wanted = shouldRetry ? shouldRetry(err) : true;
      if (attempt === attempts || !(transient && wanted)) throw err;
      const delay = baseDelayMs * Math.pow(factor, attempt - 1) * (1 + Math.random() * jitter);
      await sleep(Math.min(delay, 60_000));
    }
  }
  throw lastErr;
}
