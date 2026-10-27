# @quantcdn/edge-kv

The Quant edge `kvStore` API and a local KV and ledger backend. Use it to run edge functions that use `kvStore` on
your own computer, for example in `quant serve`, in tests, or in an emulator.

> **Caution:** This package is not a production store. It has no durability guarantee and no access control except
> the store allow-list, and it uses local keys only. Do not put real secrets or personal data in it.

The code is the reference adapter of [`@quantcdn/kv-ledger-conformance`](https://github.com/quantcdn/kv-ledger-conformance).
The conformance suite tests it on each change, with the same cases that it runs against the edge runtime.

## Install

```sh
npm install @quantcdn/edge-kv@next
```

Node 20 or later. ESM only.

## Quick start

```js
import { createLocalKv } from '@quantcdn/edge-kv';

const { kvStore, backend } = createLocalKv({ indexes: { initialState: 'ACTIVE' } });
await backend.createStore({ id: 'site-data', format: 2 });

// Give kvStore to the edge function as the global `kvStore`.
const store = kvStore.open('site-data');
await store.set('user:42', { name: 'Ada' }, { ttl: 3600 });
await store.get('user:42'); // { name: 'Ada' }
```

`createLocalKv(options)` returns `{ kvStore, backend, KVError }`. Options:

| Option | Meaning |
|---|---|
| `clock` | `{ now() }`. Default: the real clock. |
| `isAllowed(storeId)` | The stores the function may use. Default: every store of the backend. Other stores give `FORBIDDEN`. |
| `storage` | The storage hook. See below. Without it, the data is in memory only. |
| `indexes` | `{ initialState, activationMs, listLagMs }`. See below. |
| `keys` | `{ secret, cursor, proof }`: local keys. New keys are made when absent. Keep them with the data, or secret values and cursors stop working after a restart. |
| `warn(message)` | Called for each unknown `set` or `delete` option. |
| `org`, `seed`, `budgetRows` | The org in ledger sources, the ledger shard seed, and the scan budget of a list page. |

The `kvStore` has the same argument checks, `KVError` codes and shapes as the edge runtime. The types are in
`index.d.ts` (`KvStore`, `KVError`, `QueryPage`, `AppendReceipt` and the others).

## Storage hook

The backend does no I/O. The storage hook does the I/O:

| Function | Meaning |
|---|---|
| `load()` | Sync. Returns the snapshot, or `null`. Called at start, and after `changed()` returns `true`. |
| `save(snapshot)` | Sync. Called after each write, also after a write that throws. Not used when `transaction` is present. |
| `transaction(run)` | Optional, async. Each write calls it. Take the lock, load the fresh snapshot (or `null`), call `run(fresh)`, save the snapshot that `run` returns, then release the lock. |
| `changed()` | Optional, sync. Each read calls it. When it returns `true`, the backend reloads with `load()`. |

Use `transaction` and `changed` when two processes share one snapshot. Without them, the last process to save
overwrites the writes of the other process. The lock covers the full snapshot.

> **Caution:** With `transaction`, the backend write and admin methods return promises (`createStore`,
> `declareIndex`, `setIndexState`, `declareLedger` and the others). Always `await` them. Reads stay synchronous.

The conformance suite README has a full example on a file, with a lock file and an atomic rename.

## Index settings

| Setting | Default | Meaning |
|---|---|---|
| `initialState` | `'BUILDING'` | `'ACTIVE'` makes a new index ACTIVE at once. The backfill check still runs, so an index can be `FAILED`. Use `'ACTIVE'` for local development. |
| `activationMs` | 75000 | The time a new index stays `BUILDING`, as on the platform. |
| `listLagMs` | 0 | A list by index leaves out an item until `listLagMs` after its last write, as the runtime can. `getBy` and `count` have no lag. |

`backend.setIndexState(storeId, name, 'ACTIVE' | 'BUILDING' | 'FAILED')` holds an index in a state until the next
call. Use it to test how a function handles `INDEX_NOT_READY`.

## Other backend controls

- `backend.archiveNow(storeId)`: archive every ledger entry now, so `ledgerProof` returns a signed proof.
- `backend.injectFault({ op, when })`: the next call of `op` fails, `'before'` the write or `'after-write'`.
- `backend.setClock(ms)`: set the server time.
- `backend.snapshot()` and `backend.restore(snapshot)`: save and load the full state.

## Not in this version

- The ledger subject contract (`subjectMode`, subject entries) is not emulated yet.
- One lock covers all stores. There are no snapshots for each store.

## Licence

Apache-2.0. Copyright 2026 QuantCDN Pty Ltd.
