// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Shared state of the local backend: stores, server time, versions, store-level errors and the storage hook.
import { randomBytes } from 'node:crypto';
import { ERROR_CODES } from '../../../lib/error-contract.mjs';

/** A store record. archives and digests belong to the simulated archive (archive.mjs). */
export function newStore(id, format) {
  return { id, format, items: new Map(), idempotency: new Map(), indexes: new Map(), ledgers: new Map(),
    chains: new Map(), subjectKeys: new Map(), archives: new Map(), digests: new Map() };
}

function makeError(KVError) {
  return function storeError(code, message, details = {}) {
    const row = ERROR_CODES[code];
    const status = row && row.status !== null ? row.status : undefined;
    const retryable = row && typeof row.retryable === 'boolean' ? row.retryable : false;
    return new KVError(code, message, { status, retryable, ...details });
  };
}

/**
 * createCore({ clock, KVError, storage, org, seed }) -> the state and helpers every backend module uses.
 * now() is the injected clock plus the offset that setClock sets (server time). rngState drives the shard choice.
 */
export function createCore({ clock, KVError, storage, org, seed }) {
  const core = {
    KVError,
    org,
    rngState: seed >>> 0,
    stores: new Map(),
    offsetMs: 0,
    versionSeq: 0,
    storage,
    error: makeError(KVError),
    now: () => clock.now() + core.offsetMs,
  };
  core.needStore = (storeId) => {
    const store = core.stores.get(storeId);
    if (store === undefined) throw core.error('STORE_NOT_FOUND', `store ${storeId} does not exist`);
    return store;
  };
  core.newVersion = () => {
    core.versionSeq += 1;
    return `${core.now().toString(36)}-${core.versionSeq.toString(36)}-${randomBytes(3).toString('hex')}`;
  };
  return core;
}

/** A record is live when it exists and its expiry (epoch ms or null) is still ahead. */
export function isLive(record, now) {
  return record !== undefined && (record.expiresAt === null || now < record.expiresAt);
}

/** The collection of a format 2 key: the text before the last ':', or '' for the root collection. */
export function collectionOf(key) {
  const at = key.lastIndexOf(':');
  return at < 0 ? '' : key.slice(0, at);
}
