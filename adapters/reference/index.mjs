// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The reference adapter (spec 9): an in-memory kvStore for the emulator and for the suite's own tests. Not
// production: no durability guarantee, no access control beyond the store allow-list, local keys only.
// Two layers (spec 9.1): the edge layer (lib/edge-surface.mjs over lib/edge-calls.mjs) and the local backend
// (./backend/). The allow-list is the stores made by admin.createStore; any other store id is FORBIDDEN.
//
// createAdapter({ clock, budgetRows, seed, storage, keys, warn }):
//   clock       the clock to use (the runner's virtual clock); a virtual clock when absent
//   budgetRows  test-only scan budget per page (default LIMITS.scannedRowsPerPage); shortPages is true when it is at
//               most LIMITS.shortPagesBudgetMax
//   seed        shard choice for ledgers (default 1)
//   storage     { load(), save(snapshot) } persistence hook of the backend
//   keys        { secret, cursor } base64 local keys, proof (PKCS#8 PEM archive signing key); generated when absent
//   warn        called with a message for each unknown set/delete option (the warn phase); silent when absent
//   indexes     { initialState, activationMs, listLagMs } index settings of the backend (backend/indexes.mjs)
import { buildKvStore } from '../../lib/edge-surface.mjs';
import { createEdgeChecks } from '../../lib/edge-checks.mjs';
import { createKVErrorClass } from '../../lib/kv-error.mjs';
import { createVirtualClock } from '../../lib/clock.mjs';
import { LIMITS } from '../../lib/limits.mjs';
import { createLocalBackend } from './backend/index.mjs';
import { indexSettings } from './backend/indexes.mjs';
import { createEdgeCalls } from '../../lib/edge-calls.mjs';

// An emulator can put the local backend behind its own edge layer.
export { createLocalBackend };

const STORE_PREFIX = 'kvc-';
const ORG = 'local-org';

function capabilitiesOf(clock, budgetRows, indexes) {
  return {
    virtualClock: clock.virtual === true,
    eventualIndexLists: indexes.listLagMs > 0,
    indexBuildStates: indexes.initialState === 'BUILDING',
    proofTiming: true,
    signedProofs: true,
    search: true,
    secretEncryption: true,
    subjectV1: false,
    setClock: true,
    advanceArchive: true,
    injectFault: true,
    shortPages: budgetRows <= LIMITS.shortPagesBudgetMax,
  };
}

// The highest n of the kvc-<n> ids a restored backend already holds.
const highestStoreNumber = (ids) => ids.reduce((max, id) => {
  const n = id.startsWith(STORE_PREFIX) ? Number(id.slice(STORE_PREFIX.length)) : NaN;
  return Number.isSafeInteger(n) && n > max ? n : max;
}, 0);

// wait: true resolves when the ledger is ACTIVE; with a virtual clock it also moves the clock to activeAfter.
async function declareLedger(backend, clock, storeId, def, { wait = true } = {}) {
  const result = await backend.declareLedger(storeId, def, { wait });
  const ahead = Date.parse(result.activeAfter) - backend.now();
  if (wait && clock.virtual === true && ahead > 0) await clock.advance(ahead);
  return result;
}

function createAdmin(backend, allowed, clock) {
  let counter = highestStoreNumber([...allowed]);
  return {
    async createStore({ format = 2 } = {}) {
      counter += 1;
      const storeId = `${STORE_PREFIX}${counter}`;
      await backend.createStore({ id: storeId, format });
      allowed.add(storeId);
      return { storeId, identity: { org: ORG, store: storeId } };
    },
    // wait (default true): the index is ACTIVE (or FAILED by its backfill) when this resolves.
    async declareIndex(storeId, def, { wait = true } = {}) {
      return backend.declareIndex(storeId, def, { wait });
    },
    async dropIndex(storeId, name) {
      await backend.dropIndex(storeId, name);
    },
    // wait (default true): the ledger is ACTIVE when this resolves. wait false: PENDING until activeAfter.
    declareLedger: (storeId, def, options) => declareLedger(backend, clock, storeId, def, options),
    async dropLedger(storeId, name) {
      await backend.dropLedger(storeId, name);
    },
    // The PEM of the local P-256 key that signs the archive digests (one key for every store).
    async proofPublicKey(storeId) {
      backend.storeFormat(storeId);
      return backend.publicKey();
    },
    async dispose() {
      await backend.reset();
      allowed.clear();
    },
  };
}

function createControl(backend) {
  return {
    async setClock(ms) {
      await backend.setClock(ms);
    },
    async injectFault(fault) {
      backend.injectFault(fault);
    },
    // Archive every unarchived entry of the store now (pending -> archived).
    async advanceArchive(storeId) {
      await backend.archiveNow(storeId);
    },
    // Hold an index in a state: 'ACTIVE' (no backfill check), 'BUILDING' or 'FAILED'.
    async setIndexState(storeId, name, state) {
      return backend.setIndexState(storeId, name, state);
    },
  };
}

function checkBudget(budgetRows) {
  if (!Number.isSafeInteger(budgetRows) || budgetRows < 1) throw new TypeError('budgetRows must be a positive integer');
}

export async function createAdapter(options = {}) {
  const { clock = createVirtualClock(), budgetRows = LIMITS.scannedRowsPerPage, seed = 1, storage, keys, warn } = options;
  checkBudget(budgetRows);
  const indexes = indexSettings(options.indexes);
  const KVError = createKVErrorClass();
  const backend = createLocalBackend({ clock, KVError, budgetRows, seed, storage, keys, indexes, org: ORG });
  const allowed = new Set(backend.storeIds());
  const calls = createEdgeCalls({
    backend, checks: createEdgeChecks(KVError), KVError, isAllowed: (id) => allowed.has(id), warn,
  });
  return {
    name: 'reference',
    kvStore: buildKvStore(calls, KVError),
    shapes: ['global', 'handle'],
    clock,
    capabilities: capabilitiesOf(clock, budgetRows, indexes),
    admin: createAdmin(backend, allowed, clock),
    control: createControl(backend),
    backend,
  };
}
