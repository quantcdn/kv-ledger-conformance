// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The storage hook of the local backend. The backend stays I/O-free: the hook does the I/O.
//
// storage.load()         sync. The snapshot, or null. Called at create, and by refresh after changed().
// storage.save(snap)     sync. Called after each write, also a write that throws (a lost response after the write).
// storage.transaction    optional: async (run) => snapshot. When present, it replaces save. Each write calls
//                        storage.transaction(async (fresh) => next): the hook takes its lock, loads the fresh
//                        snapshot (or null), calls the function, saves the snapshot it returns, and releases the lock.
//                        Writes then return promises, and they run in the order of the calls.
// storage.changed()      optional, sync. Reads call it, and reload with storage.load() when it returns true
//                        (for example an mtime check). Without it, a process does not see the writes of another.

// Each write saves a snapshot afterwards, also when it throws.
function savedAfter(storage, snapshot) {
  return (work) => {
    try {
      return work();
    } finally {
      storage.save(snapshot());
    }
  };
}

// Each write runs inside storage.transaction, after the earlier writes of this process.
function inTransaction(storage, snapshot, restore) {
  let tail = Promise.resolve();
  const run = async (work) => {
    let outcome;
    await storage.transaction(async (fresh) => {
      if (fresh) restore(fresh);
      try {
        outcome = { value: work() };
      } catch (error) {
        outcome = { error };
      }
      return snapshot();
    });
    if (outcome === undefined) throw new Error('storage.transaction did not run the write');
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  };
  return (work) => {
    const result = tail.then(() => run(work));
    tail = result.catch(() => {});
    return result;
  };
}

/** { persisted(work), refresh() } for the storage hook. persisted runs a write; refresh runs before a read. */
export function createPersistence(storage, { snapshot, restore }) {
  if (!storage) return { persisted: (work) => work(), refresh: () => {} };
  const refresh = () => {
    if (typeof storage.changed !== 'function' || !storage.changed()) return;
    const loaded = storage.load();
    if (loaded) restore(loaded);
  };
  const persisted = typeof storage.transaction === 'function'
    ? inTransaction(storage, snapshot, restore)
    : savedAfter(storage, snapshot);
  return { persisted, refresh };
}
