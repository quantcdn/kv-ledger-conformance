// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// @quantcdn/edge-kv: the edge kvStore layer (argument checks, KVError, iteration, the store handle) over the local
// KV and ledger backend. The src/ modules are copies of the conformance suite's reference adapter, so the suite tests
// this code. Not a production store: no durability guarantee, local keys only.
import { buildKvStore } from './src/lib/edge-surface.mjs';
import { createEdgeCalls } from './src/lib/edge-calls.mjs';
import { createEdgeChecks } from './src/lib/edge-checks.mjs';
import { createKVErrorClass } from './src/lib/kv-error.mjs';
import { createRealClock } from './src/lib/clock.mjs';
import { createLocalBackend } from './src/adapters/reference/backend/index.mjs';

export { buildKvStore, createEdgeCalls, createEdgeChecks, createKVErrorClass, createLocalBackend };
export { createRealClock, createVirtualClock } from './src/lib/clock.mjs';
export { LIMITS } from './src/lib/limits.mjs';
export { ERROR_CODES } from './src/lib/error-contract.mjs';

/**
 * createLocalKv(options) -> { kvStore, backend, KVError }: a kvStore for an edge function, over a new local backend.
 * options: the createLocalBackend options (clock defaults to the real clock), plus isAllowed(storeId) (the stores
 * the function may use; default: every store of the backend) and warn(message) (unknown set and delete options).
 */
export function createLocalKv(options = {}) {
  const { isAllowed, warn, ...backendOptions } = options;
  const KVError = backendOptions.KVError ?? createKVErrorClass();
  const backend = createLocalBackend({ clock: createRealClock(), ...backendOptions, KVError });
  const allowed = isAllowed ?? ((storeId) => backend.storeIds().includes(storeId));
  const calls = createEdgeCalls({ backend, checks: createEdgeChecks(KVError), KVError, isAllowed: allowed, warn });
  return { kvStore: buildKvStore(calls, KVError), backend, KVError };
}
