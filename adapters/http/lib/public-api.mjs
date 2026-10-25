// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// A small client for the public KV v2 API (public API spec 4.28.0): every path is under
// <base>/api/v2/organizations/{organization}/projects/{project}/kv. One request function with a token-bucket rate
// cap, JSON bodies, a timeout, and the error mapping to the adapter's KVError.
//
// createPublicApi({ base, org, project, token, rate = 3, fetch, timeoutMs, KVError }) -> { request, rate }
//   request(method, path, { query, body }) -> { status, body, retryAfter }   (path is relative to .../kv)
//
// The token goes only in the Authorization header of each request. It is never kept on an object, never logged and
// never put in an error: a server text that echoes it is redacted, and transport errors carry no cause.
// Errors: the documented error body ({ error, code, message, retryable, ...details }) keeps its code, status,
// retryable and scalar details. Without a code: 5xx and 429 are UNAVAILABLE (retryable), 404 is NOT_FOUND, any
// other 4xx is VALIDATION. A 2xx body that is not JSON is RESPONSE_INVALID. No answer (network error or timeout) is
// UNAVAILABLE, retryable only for GET (after a write the outcome is unknown).
import { isPlainObject } from '../../../lib/check-util.mjs';

const DEFAULT_TIMEOUT_MS = 30000;
const MESSAGE_MAX = 500;
const BODY_FIELDS = ['error', 'code', 'message', 'retryable', 'status'];

/**
 * A token bucket: `rate` tokens per second, at most `capacity` held (the burst). take() resolves when a token is had.
 * The capacity is Math.max(rate, 1): a rate below 1 per second (for example 0.5) holds one token, so it paces one
 * request every 1/rate seconds with no burst.
 */
export function createTokenBucket(rate, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const capacity = Math.max(rate, 1);
  let tokens = capacity;
  let last = now();
  let chain = Promise.resolve();
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - last) * rate) / 1000);
    last = t;
  };
  async function takeOne() {
    refill();
    if (tokens < 1) {
      await sleep(Math.ceil(((1 - tokens) * 1000) / rate));
      refill();
    }
    tokens -= 1;
  }
  return {
    take() {
      chain = chain.then(takeOne);
      return chain;
    },
  };
}

const redactor = (token) => (text) => String(text).split(token).join('[redacted]').slice(0, MESSAGE_MAX);

function queryString(query = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value !== undefined) params.append(name, String(value));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** Retry-After as a number of seconds, or the HTTP date text, or undefined. */
function retryAfterOf(headers) {
  const value = headers.get('retry-after');
  if (value === null || value === '') return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : value;
}

function fallbackCode(status) {
  if (status >= 500 || status === 429) return 'UNAVAILABLE';
  return status === 404 ? 'NOT_FOUND' : 'VALIDATION';
}

/** The detail fields of a documented error body, strings redacted (KVError keeps only the scalar contract fields). */
function detailsOf(body, redact) {
  if (!isPlainObject(body) || typeof body.code !== 'string') return {};
  const out = {};
  for (const [name, value] of Object.entries(body)) {
    if (!BODY_FIELDS.includes(name)) out[name] = typeof value === 'string' ? redact(value) : value;
  }
  return out;
}

function errorOf({ status, body, retryAfter }, KVError, redact) {
  const documented = isPlainObject(body) && typeof body.code === 'string';
  const code = documented ? body.code : fallbackCode(status);
  const retryable = typeof body?.retryable === 'boolean' ? body.retryable : status >= 500 || status === 429;
  const message = typeof body?.message === 'string' ? body.message : `the public API answered ${status}`;
  return new KVError(code, redact(message), { ...detailsOf(body, redact), status, retryable, retryAfter });
}

function parseBody(text) {
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function checkRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new TypeError('rate must be a positive number of requests per second');
}

export function createPublicApi({ base, org, project, token, rate = 3, fetch: fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS, KVError }) {
  checkRate(rate);
  const root = `${String(base).replace(/\/+$/, '')}/api/v2/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/kv`;
  const bucket = createTokenBucket(rate);
  const redact = redactor(token);

  // Sends one request; the answer, or a KVError with no cause (the request holds the token).
  async function send(method, path, { query, body }) {
    const init = { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      const response = await fetchFn(`${root}${path}${queryString(query)}`, init);
      return { status: response.status, text: await response.text(), retryAfter: retryAfterOf(response.headers) };
    } catch (err) {
      const kind = err?.name === 'TimeoutError' ? 'timeout' : 'network error';
      throw new KVError('UNAVAILABLE', `no answer from the public API for ${method} ${redact(path)} (${kind})`, { retryable: method === 'GET' });
    }
  }

  async function request(method, path, options = {}) {
    await bucket.take();
    const { status, text, retryAfter } = await send(method, path, options);
    const parsed = parseBody(text);
    if (status >= 200 && status < 300) {
      if (!parsed.ok) throw new KVError('RESPONSE_INVALID', `the public API answered ${status} with a body that is not JSON`, { status });
      return { status, body: parsed.value, retryAfter };
    }
    throw errorOf({ status, body: parsed.ok ? parsed.value : null, retryAfter }, KVError, redact);
  }

  return Object.freeze({ request, rate });
}
