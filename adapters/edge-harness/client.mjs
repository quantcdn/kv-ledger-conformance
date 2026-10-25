// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The transport of the edge-harness adapter: one POST per call to the deployed harness-fn.js, the argument encoding
// (undefined travels as an index list), and the rebuild of an error from its fields. The token goes only in the
// request body: it is never put in an error, a log line or a result.

/** { args, undef? }: the args as JSON can carry them, with the indexes of the undefined ones. */
export function encodeArgs(args) {
  const undef = [];
  const out = args.map((value, i) => {
    if (value !== undefined) return value;
    undef.push(i);
    return null;
  });
  return undef.length ? { args: out, undef } : { args: out };
}

const NATIVE = { TypeError, RangeError, SyntaxError, Error };
const UNSAFE_FIELDS = ['__proto__', 'constructor', 'prototype'];

function baseError(info, KVError) {
  if (info.instanceOfKVError) return new KVError(info.code, info.message);
  const Native = Object.hasOwn(NATIVE, info.name) ? NATIVE[info.name] : Error;
  return new Native(info.message);
}

// Plain copies: a field named __proto__ or constructor never reaches the error (no prototype change).
function copyFields(err, fields = {}) {
  for (const [name, value] of Object.entries(fields)) if (!UNSAFE_FIELDS.includes(name)) err[name] = value;
}

/** A local error from the harness error fields: a KVError of the adapter's class when the runtime threw one. */
export function rebuildError(info, KVError) {
  const err = baseError(info, KVError);
  for (const name of ['status', 'retryable']) delete err[name];
  if (info.instanceOfKVError || info.name !== undefined) err.name = info.name;
  for (const name of ['code', 'status', 'retryable']) if (info[name] !== undefined) err[name] = info[name];
  copyFields(err, info.fields);
  return err;
}

const MESSAGE_MAX = 300;

// The token never reaches an error text, even when a server echoes the request.
const redact = (text, token) => String(text).split(token).join('[redacted]').slice(0, MESSAGE_MAX);

async function post(fetchFn, url, payload, token) {
  try {
    return await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  } catch (err) {
    // No cause: a transport error can hold the request, and the request holds the token.
    throw new Error(`edge harness request failed: ${redact(err?.message ?? err, token)}`);
  }
}

async function errorText(res, token) {
  const text = await res.text().catch(() => '');
  return redact(text, token);
}

/** send(calls) -> results. Throws a plain Error (no token in it) when the harness refuses or does not answer. */
export function createClient({ url, token, fetch: fetchFn = globalThis.fetch }) {
  return async function send(calls) {
    const res = await post(fetchFn, url, JSON.stringify({ token, calls }), token);
    if (res.status !== 200) throw new Error(`edge harness answered ${res.status}: ${await errorText(res, token)}`);
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body?.results) || body.results.length !== calls.length) {
      throw new Error('edge harness answer has no results for the calls');
    }
    return body.results;
  };
}
