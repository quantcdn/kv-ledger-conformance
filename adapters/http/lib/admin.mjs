// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The admin of the HTTP adapter (spec 3, 10.2) over the public KV v2 API. Also the default admin of the
// edge-harness adapter. Operations: KV_create and KV_show (readiness), KV_delete, KV_indexes_create/show/delete,
// KV_ledgers_create/show/delete, KV_ledgers_public_key.
//
// createAdmin({ api, org, stores, clock, pollMs, log }):
//   stores   Map storeId -> { name, format }: the stores this adapter created (the kvStore allow-list)
//   clock    waits between polls (clock.advance); pollMs the wait when the API gives no Retry-After
//   log      called with one line when dispose could not delete a store (default: standard error)
// Admin requests that answer 429 or 503 with retryable true are sent again after Retry-After (kv-admin operations
// share a per-project rate limit), at most MAX_ATTEMPTS sends in all. A Retry-After is capped at RETRY_AFTER_MAX_MS;
// Retry-After 0 means retry now (a wait of RETRY_NOW_MS); without one the wait is pollMs. Waits have deadlines: no wait goes past the deadline of its poll, and a deadline
// that passes throws a plain Error. Time comes from clock.now(). Data calls (the kvStore) are never retried here.
import { randomBytes } from 'node:crypto';
import { LIMITS } from '../../../lib/limits.mjs';
import { definitionOf } from './mapping.mjs';

const RETRY_STATUSES = [429, 503];
export const MAX_ATTEMPTS = 8;
export const RETRY_AFTER_MAX_MS = 60000;
export const RETRY_NOW_MS = 250; // the wait for Retry-After 0 (retry now)
const STORE_READY_MS = 180000;
const INDEX_READY_MS = 900000;
const LEDGER_READY_MS = 900000;

const enc = encodeURIComponent;
const runTag = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const writeLine = (line) => process.stderr.write(`${line}\n`);

// The wait a Retry-After asks for (seconds), at least RETRY_NOW_MS and capped; pollMs when there is none.
function waitOf(retryAfter, pollMs) {
  if (typeof retryAfter !== 'number') return pollMs;
  return Math.min(Math.max(retryAfter * 1000, RETRY_NOW_MS), RETRY_AFTER_MAX_MS);
}

const canRetry = (err, attempt) => err?.retryable === true && RETRY_STATUSES.includes(err.status) && attempt < MAX_ATTEMPTS;

export function createAdmin({ api, org, stores, clock, pollMs = 5000, log = writeLine }) {
  const tag = runTag();
  let counter = 0;

  // The time left before `deadline` (Infinity when there is none).
  const leftUntil = (deadline) => deadline - clock.now();

  async function send(method, path, options, deadline = Infinity, attempt = 1) {
    try {
      return await api.request(method, path, options);
    } catch (err) {
      const wait = Math.min(waitOf(err?.retryAfter, pollMs), leftUntil(deadline));
      if (!canRetry(err, attempt) || wait <= 0) throw err;
      await clock.advance(wait);
      return send(method, path, options, deadline, attempt + 1);
    }
  }

  /** Reads `path` until done(body) holds; the last body. No wait goes past the deadline. */
  async function pollUntil(path, done, deadlineMs, what) {
    const deadline = clock.now() + deadlineMs;
    for (;;) {
      const { body, retryAfter } = await send('GET', path, undefined, deadline);
      if (done(body)) return body;
      const wait = Math.min(waitOf(retryAfter, pollMs), leftUntil(deadline));
      if (wait <= 0) throw new Error(`http adapter: ${what} did not finish in time`);
      await clock.advance(wait);
    }
  }

  async function createStore({ format = 2 } = {}) {
    counter += 1;
    const name = `kvc-${tag}-${counter}`;
    const created = await send('POST', '', { body: { name, format } });
    const storeId = created.body.id;
    stores.set(storeId, { name, format });
    if (created.body.status !== 'ready') {
      await pollUntil(`/${enc(storeId)}`, (b) => b?.status === undefined || b.status === 'ready', STORE_READY_MS, 'the store');
    }
    // The platform names a ledger instance by the store id (org-project-name), not the short name.
    return { storeId, identity: { org, store: storeId } };
  }

  async function declareIndex(storeId, def, { wait = true } = {}) {
    const path = `/${enc(storeId)}/indexes`;
    let index = (await send('POST', path, { body: def })).body;
    if (wait) index = await pollUntil(`${path}/${enc(def.name)}`, (b) => b.state !== 'BUILDING', INDEX_READY_MS, 'the index');
    return { name: index.name, state: index.state, ...(index.error ? { error: index.error } : {}) };
  }

  async function declareLedger(storeId, def, { wait = true } = {}) {
    const path = `/${enc(storeId)}/ledgers`;
    let ledger = (await send('POST', path, { body: { ...def, lockMode: def.lockMode ?? 'governance' } })).body;
    if (wait && ledger.state === 'PENDING') {
      const ahead = Date.parse(ledger.activeAfter) - clock.now();
      if (ahead > 0) await clock.advance(Math.min(ahead, LIMITS.ledgerActivationMs));
      ledger = await pollUntil(`${path}/${enc(def.name)}`, (b) => b.state !== 'PENDING', LEDGER_READY_MS, 'the ledger');
    }
    return { name: ledger.name, state: ledger.state, definition: definitionOf(ledger),
      definitionHash: ledger.definitionHash, activeAfter: ledger.activeAfter };
  }

  // Deletes every store this adapter created. A store that cannot be deleted (for example one with a ledger) is kept
  // and named (by its store id, as the platform names it) in the summary and the log line; dispose never throws for it.
  async function dispose() {
    const deleted = [];
    const kept = [];
    for (const storeId of stores.keys()) {
      try {
        await send('DELETE', `/${enc(storeId)}`, { query: { force: true } });
        deleted.push(storeId);
      } catch (err) {
        kept.push({ store: storeId, code: err?.code ?? 'UNKNOWN' });
      }
    }
    stores.clear();
    if (kept.length) log(`kv-conformance http adapter: stores not deleted: ${kept.map((k) => `${k.store} (${k.code})`).join(', ')}`);
    return { deleted, kept };
  }

  return {
    createStore,
    declareIndex,
    async dropIndex(storeId, name) {
      await send('DELETE', `/${enc(storeId)}/indexes/${enc(name)}`);
    },
    declareLedger,
    async dropLedger(storeId, name) {
      await send('DELETE', `/${enc(storeId)}/ledgers/${enc(name)}`);
    },
    async proofPublicKey(storeId) {
      return (await send('GET', `/${enc(storeId)}/ledgers/public-key`)).body.publicKeyPem;
    },
    dispose,
  };
}
