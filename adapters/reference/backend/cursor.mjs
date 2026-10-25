// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Opaque query cursors: base64url(JSON payload) + '.' + base64url(HMAC-SHA-256). The payload binds the cursor to
// the store, the query kind and the query options except limit and cursor, and records the issue time.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LIMITS } from '../../../lib/limits.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/** The binding of a query: a hash of the store id, the kind and the options that define the result set. */
export function bindingOf(storeId, options, kind) {
  const { limit, cursor, ...defining } = options;
  return createHash('sha256').update(canonical([storeId, kind, defining])).digest('base64url');
}

export function createCursors(core, keyBase64) {
  const key = keyBase64 === undefined ? randomBytes(32) : Buffer.from(keyBase64, 'base64');
  const sign = (body) => createHmac('sha256', key).update(body).digest();
  const invalid = (why) => core.error('CURSOR_INVALID', `the cursor is ${why}`);

  function issue(binding, position) {
    const body = Buffer.from(JSON.stringify({ b: binding, p: position, t: core.now() })).toString('base64url');
    return `${body}.${sign(body).toString('base64url')}`;
  }

  function payloadOf(cursor) {
    const [body, mac, extra] = cursor.split('.');
    const given = Buffer.from(mac ?? '', 'base64url');
    const ok = extra === undefined && body && given.length === 32 && timingSafeEqual(given, sign(body));
    if (!ok) throw invalid('malformed or altered');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  }

  /** The position stored in the cursor. Throws CURSOR_INVALID for a bad, foreign or expired cursor. */
  function open(cursor, binding) {
    const payload = payloadOf(cursor);
    if (payload.b !== binding) throw invalid('from a different query');
    if (core.now() - payload.t > LIMITS.cursorLifetimeMs) throw invalid('expired');
    return payload.p;
  }

  return { keyBase64: key.toString('base64'), issue, open };
}
