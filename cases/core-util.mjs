// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Helpers shared by the core case modules. Nothing here asserts exact versions, cursors or ids.
import assert from 'node:assert/strict';
import { LIMITS } from '../lib/limits.mjs';
import { bindGlobal } from '../lib/context.mjs';
import { byteCompare } from '../lib/check-util.mjs';

export { byteCompare };

/** A core case. `extra` may set needs, shapes, declares (a list of 'ledger' and 'index') or timeoutMs. */
export function coreCase(name, run, extra = {}) {
  return { name: `core/${name}`, tags: ['core'], needs: [], ...extra, run };
}

/** A store view for another store id, in the shape of the current case. */
export function viewFor(ctx, storeId) {
  return ctx.shape === 'handle' ? ctx.kvStore.open(storeId) : bindGlobal(ctx.kvStore, storeId);
}

const VALIDATION = Object.freeze({ code: 'VALIDATION', retryable: false });

/** Each target (a function) must reject with VALIDATION. */
export async function expectValidation(ctx, targets, label = '') {
  for (const [i, target] of targets.entries()) {
    try {
      await ctx.expectKVError(target, VALIDATION);
    } catch (err) {
      err.message = `${label}[${i}]: ${err.message}`;
      throw err;
    }
  }
}

/** Every page of a query, with the highest page cap. */
export async function allPages(query) {
  const pages = [];
  for await (const page of query.pages({ maxPages: LIMITS.maxPages.max })) pages.push(page);
  return pages;
}

export const keysOf = (pages) => pages.flatMap((page) => page.items.map((item) => item.key));

/** Every item key of a query, over every page. */
export async function allKeys(query) {
  return keysOf(await allPages(query));
}

/** Writes keys[i] = valueOf(key, i), one after the other. */
export async function fill(kv, keys, valueOf = (key, i) => i) {
  for (const [i, key] of keys.entries()) await kv.set(key, valueOf(key, i));
}

/** n zero-padded names `${prefix}${i}`, in a mixed (not sorted) write order: odd indexes down, then even up. */
export function names(prefix, n) {
  const list = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
  const odd = list.filter((_, i) => i % 2 === 1).reverse();
  return [...odd, ...list.filter((_, i) => i % 2 === 0)];
}

export const sortBytes = (list) => [...list].sort(byteCompare);

export function assertSameSet(actual, expected, label) {
  assert.equal(actual.length, new Set(actual).size, `${label}: no key twice`);
  assert.deepEqual(sortBytes(actual), sortBytes(expected), label);
}

/** expiresAt is epoch milliseconds or ISO 8601 text. */
export function assertTime(value, label) {
  const ok = (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
  assert.ok(ok, `${label}: expected epoch ms or ISO text, got ${String(value)}`);
}

export const TTL_MS = LIMITS.ttl.min * 1000;
export const PAST_TTL_MS = TTL_MS + 1000;

const EVENTUAL_TRIES = 10;
const EVENTUAL_STEP_MS = 1000;

/** Runs fn; when the adapter has eventually consistent index lists, retries a failing fn after clock.advance. */
export async function eventually(ctx, fn) {
  const tries = ctx.caps.eventualIndexLists ? EVENTUAL_TRIES : 1;
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      await ctx.clock.advance(EVENTUAL_STEP_MS);
    }
  }
}
