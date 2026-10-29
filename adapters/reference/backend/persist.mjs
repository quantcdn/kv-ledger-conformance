// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The storage hook of the local backend. The backend stays I/O-free: the hook does the I/O.
//
// storage.load()         sync. The snapshot, or null. Called at create, by refresh after changed(), and after a
//                        failed save. null keeps the state in memory (a later save writes it back).
// storage.save(snap)     sync. Called after each write, also a write that throws (a lost response after the write).
//                        Required without transaction.
// storage.transaction    optional: async (run) => void. When present, it replaces save. Each write calls
//                        storage.transaction(async (fresh) => next): the hook takes its lock, loads the fresh
//                        snapshot (or null), calls the function, saves the snapshot it returns, and releases the lock.
//                        Writes then return promises, and they run in the order of the calls. The hook must not call
//                        a backend write itself (that waits for its own lock).
// storage.changed()      optional, sync. Reads (and, without transaction, writes) call it first, and reload with
//                        storage.load() when it returns true (for example an mtime check).
//
// When the save fails (save or transaction throws after the write ran), the state in memory goes back to the disk
// state: load(), or, when load gives null or throws, the fresh snapshot of the transaction or the snapshot that this
// hook last saved or loaded. Only when none of them exists (the first write on an empty disk, or the first write
// after backend.restore()) does a write take a snapshot before it runs. So a write takes one snapshot (the one it
// saves) in the steady state.

// load(), or the fallback when load gives null or throws.
function diskOr(storage, fallback) {
  try {
    return storage.load() ?? fallback;
  } catch {
    return fallback;
  }
}

// Each write reloads a changed snapshot first, and saves afterwards, also when it throws. known.state: the snapshot
// last saved or loaded (the disk state).
function savedAfter(storage, { snapshot, restore }, refresh, known) {
  return (work) => {
    refresh();
    const before = known.state === undefined ? snapshot() : undefined;
    let outcome;
    try {
      outcome = { value: work() };
    } catch (error) {
      outcome = { error };
    }
    try {
      const next = snapshot();
      storage.save(next);
      known.state = next;
    } catch (error) {
      restore(diskOr(storage, known.state ?? before));
      throw error;
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  };
}

// One write inside storage.transaction: { value } or { error } of the work, or the error of the save. The fresh
// snapshot is the disk state before the write; a snapshot is taken only when the disk has none.
async function transactOnce(storage, { snapshot, restore }, work) {
  let outcome;
  let before;
  try {
    await storage.transaction(async (fresh) => {
      if (fresh) restore(fresh);
      before = fresh || snapshot();
      try {
        outcome = { value: work() };
      } catch (error) {
        outcome = { error };
      }
      return snapshot();
    });
  } catch (error) {
    if (before !== undefined) restore(diskOr(storage, before));
    throw error;
  }
  if (outcome === undefined) throw new Error('storage.transaction did not run the write');
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

// Each write runs inside storage.transaction, after the earlier writes of this process. While writes are in
// flight, reads do not reload: the memory is ahead of the disk until the save.
function inTransaction(storage, state, flight) {
  let tail = Promise.resolve();
  return (work) => {
    flight.count += 1;
    const result = tail.then(() => transactOnce(storage, state, work));
    const done = result.finally(() => {
      flight.count -= 1;
    });
    tail = done.catch(() => {});
    return done;
  };
}

function checkStorage(storage) {
  if (typeof storage.load !== 'function') throw new TypeError('storage needs load()');
  const writes = typeof storage.transaction === 'function' || typeof storage.save === 'function';
  if (!writes) throw new TypeError('storage needs save() or transaction()');
}

/**
 * { persisted(work), refresh(), start(), forget() } for the storage hook. persisted runs a write; refresh runs before
 * a read; start loads the disk state when the backend is made; forget is called after a restore from outside.
 */
export function createPersistence(storage, state) {
  if (!storage) return { persisted: (work) => work(), refresh: () => {}, start: () => {}, forget: () => {} };
  checkStorage(storage);
  const flight = { count: 0 };
  const known = { state: undefined };
  const load = () => {
    const loaded = storage.load();
    if (loaded) state.restore(loaded);
    known.state = loaded || undefined;
  };
  const refresh = () => {
    if (flight.count > 0 || typeof storage.changed !== 'function' || !storage.changed()) return;
    load();
  };
  const persisted = typeof storage.transaction === 'function'
    ? inTransaction(storage, state, flight)
    : savedAfter(storage, state, refresh, known);
  return { persisted, refresh, start: load, forget: () => { known.state = undefined; } };
}
