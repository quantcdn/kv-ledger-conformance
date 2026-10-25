// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// createLocalBackend: the local backend of the reference adapter (spec 9.1). Store-id-first methods take arguments
// the edge layer has already checked, return plain data, and throw KVError with the store-level status.
// It never imports the edge layer.
//
// Options: clock (required: now()), KVError (the class to throw; a fresh one when absent), budgetRows (scan
// budget per page), seed (shard choice, for ledgers), org (the org of the identity; 'local-org' by default), keys ({ secret, cursor }: base64 keys;
// proof: the PKCS#8 PEM of the local P-256 archive signing key; generated when absent),
// storage ({ load(): snapshot | null, save(snapshot) }: loaded at create, saved after each write).
import { LIMITS } from '../../../lib/limits.mjs';
import { createKVErrorClass } from '../../../lib/kv-error.mjs';
import { createCore, newStore } from './core.mjs';
import { createCursors } from './cursor.mjs';
import { createFaults } from './faults.mjs';
import { createIndexes, createWriteRules } from './indexes.mjs';
import { createArchive } from './archive.mjs';
import { createSigner } from './archive-sign.mjs';
import { createAppend } from './ledger-append.mjs';
import { createLedgerViews } from './ledger-views.mjs';
import { createLedgers } from './ledgers.mjs';
import { createQuery } from './query.mjs';
import { createSealer } from './secret.mjs';
import { applySnapshot, takeSnapshot } from './snapshot.mjs';
import { createTransactions } from './transact.mjs';
import { createValues } from './values.mjs';

// Each write saves a snapshot afterwards, also when it throws (a lost response after the write).
function createWrites(core, values, faults, persisted) {
  const notConditional = (o = {}) => o.ifAbsent === undefined && o.ifVersion === undefined;
  return {
    put: (storeId, key, raw, options = {}) => persisted(() => {
      const store = core.needStore(storeId);
      return faults.run('set', { retryable: notConditional(options) }, () => (
        { version: values.writeSet(store, key, raw, options).version }));
    }),
    remove: (storeId, key, options = {}) => persisted(() => {
      const store = core.needStore(storeId);
      faults.run('delete', { retryable: notConditional(options) }, () => values.writeDelete(store, key, options));
      return true;
    }),
    increment: (storeId, key, amount, options = {}) => persisted(() => {
      const store = core.needStore(storeId);
      return faults.run('increment', { retryable: false }, () => {
        values.checkIncrement(store, key);
        const problem = values.incrementProblem(store, key, amount);
        if (problem !== null) throw values.conflict(key, problem);
        return values.writeIncrement(store, key, amount, options);
      });
    }),
  };
}

function createReads(core, values) {
  function get(storeId, key) {
    const store = core.needStore(storeId);
    const record = values.live(store, key);
    return record === undefined ? null : values.view(store, key, record);
  }
  function batchGet(storeId, keys) {
    const store = core.needStore(storeId);
    const result = keys.map((key) => {
      const record = values.live(store, key);
      return record === undefined ? null : values.view(store, key, record);
    });
    const bytes = result.reduce((sum, r) => sum + (r === null ? 0 : Buffer.byteLength(JSON.stringify(r))), 0);
    if (bytes > LIMITS.getMany.maxBytes) throw core.error('LIMIT_EXCEEDED', 'the getMany response is over its byte limit');
    return result;
  }
  return { get, batchGet };
}

function createIndexCalls(core, values, indexes, save) {
  return {
    declareIndex(storeId, def, options) {
      const result = indexes.declareIndex(storeId, def, options);
      save();
      return result;
    },
    dropIndex(storeId, name) {
      indexes.dropIndex(storeId, name);
      save();
      return true;
    },
    lookup(storeId, index, equals) {
      const store = core.needStore(storeId);
      const row = indexes.lookup(store, index, equals);
      return row === null ? null : values.view(store, row.key, row.record);
    },
    count: (storeId, { index, equals } = {}) => indexes.count(core.needStore(storeId), index, equals),
  };
}

// Status and proof calls can run the archive (lazily, by the clock), so they save too.
function createLedgerCalls(core, ledgers, appends, archive, persisted) {
  return {
    declareLedger: (storeId, def, options) => persisted(() => ledgers.declareLedger(storeId, def, options)),
    dropLedger: (storeId, name) => persisted(() => ledgers.dropLedger(storeId, name)),
    append: (storeId, collection, value, options) => persisted(() => appends.append(storeId, collection, value, options)),
    ledgerStatus: (storeId, name) => persisted(() => ledgers.ledgerStatus(storeId, name)),
    ledgerProof: (storeId, name, key) => persisted(() => ledgers.ledgerProof(storeId, name, key)),
    archiveNow: (storeId) => persisted(() => {
      archive.archiveNow(core.needStore(storeId));
      return true;
    }),
  };
}

function createStoreAdmin(core, save) {
  return {
    createStore({ id, format = 2 }) {
      if (core.stores.has(id)) throw core.error('VALIDATION', `store ${id} exists`);
      core.stores.set(id, newStore(id, format));
      save();
      return { id, format };
    },
    deleteStore(id) {
      core.needStore(id);
      core.stores.delete(id);
      save();
      return true;
    },
    storeIds: () => [...core.stores.keys()],
    storeFormat: (id) => core.needStore(id).format,
    reset() {
      core.stores.clear();
      save();
    },
  };
}

// Local keys (secret, cursor, proof), replaced on restore. The modules hold forwarding objects, not the keys.
function createKeyring(core, keys = {}) {
  let sealer = createSealer(keys.secret);
  let cursors = createCursors(core, keys.cursor);
  let signer = createSigner(keys.proof);
  return {
    sealer: { seal: (text) => sealer.seal(text), open: (sealed) => sealer.open(sealed) },
    cursors: { issue: (...a) => cursors.issue(...a), open: (...a) => cursors.open(...a) },
    signer: { get keyId() { return signer.keyId; }, sign: (digest) => signer.sign(digest) },
    publicKey: () => signer.publicKeyPem,
    current: () => ({ secret: sealer.keyBase64, cursor: cursors.keyBase64, proof: signer.privatePem }),
    replace(given = {}) {
      sealer = createSealer(given.secret);
      cursors = createCursors(core, given.cursor);
      signer = createSigner(given.proof);
    },
  };
}

export function createLocalBackend(options = {}) {
  const { clock, budgetRows = LIMITS.scannedRowsPerPage, seed = 1, keys, storage, org = 'local-org' } = options;
  if (typeof clock?.now !== 'function') throw new TypeError('createLocalBackend needs a clock with now()');
  const KVError = options.KVError ?? createKVErrorClass();
  const core = createCore({ clock, KVError, storage, org, seed });
  const keyring = createKeyring(core, keys);

  const snapshot = () => takeSnapshot(core, keyring.current());
  const save = () => {
    if (storage) storage.save(snapshot());
  };
  const persisted = (work) => {
    try {
      return work();
    } finally {
      save();
    }
  };
  const restore = (data) => keyring.replace(applySnapshot(core, data));

  const indexes = createIndexes(core);
  const archive = createArchive(core, keyring.signer);
  const ledgers = createLedgers(core, { archive });
  const ledgerViews = createLedgerViews(core);
  const rules = { ...createWriteRules(core, indexes), checkMutable: ledgers.checkMutable };
  const values = createValues(core, keyring.sealer, rules, ledgerViews);
  const faults = createFaults(core);
  const { transact } = createTransactions(core, values, faults);
  const { query } = createQuery(core, { budgetRows, cursors: keyring.cursors, indexes, ledgers, ledgerViews });

  const backend = {
    ...createStoreAdmin(core, save),
    ...createReads(core, values),
    ...createWrites(core, values, faults, persisted),
    transact: (storeId, ops, opts) => persisted(() => transact(storeId, ops, opts)),
    query,
    ...createIndexCalls(core, values, indexes, save),
    ...createLedgerCalls(core, ledgers, createAppend(core, ledgers, faults), archive, persisted),
    publicKey: () => keyring.publicKey(),
    injectFault: (fault) => faults.inject(fault),
    now: () => core.now(),
    setClock(ms) {
      core.offsetMs = ms - clock.now();
    },
    snapshot,
    restore,
  };

  const loaded = storage ? storage.load() : null;
  if (loaded) restore(loaded);
  return backend;
}
