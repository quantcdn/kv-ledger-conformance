// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// A minimal adapter for the CLI tests: no store behaviour, only what the runner needs.
import { createKVErrorClass } from '../../lib/kv-error.mjs';

export async function createAdapter({ clock }) {
  const KVError = createKVErrorClass();
  return {
    name: 'fake',
    kvStore: { KVError, open: (storeId) => ({ storeId }) },
    shapes: ['global', 'handle'],
    clock,
    capabilities: { virtualClock: true },
    admin: {
      createStore: async () => ({ storeId: 's1', identity: { org: 'o', store: 's1' } }),
      dispose: async () => {},
    },
  };
}
