# @quantcdn/edge-kv

The Quant edge `kvStore` API and a local KV and ledger backend. Use it to run edge functions that use `kvStore` on
your own computer, for example in `quant serve`, in tests, or in an emulator.

> **Caution:** This package is not a production store. It has no durability guarantee and no access control except
> the store allow-list, and it uses local keys only. Do not put real secrets or personal data in it.

The code is the reference adapter of [`@quantcdn/kv-ledger-conformance`](https://github.com/quantcdn/kv-ledger-conformance).
The conformance suite tests it on each change, with the same cases that it runs against the edge runtime.

## Install

```sh
npm install @quantcdn/edge-kv
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
| `load()` | Sync. Returns the snapshot, or `null`. Called at start, after `changed()` returns `true`, and after a failed save. `null` keeps the state in memory. |
| `save(snapshot)` | Sync. Called after each write, also after a write that throws. Required when `transaction` is absent. |
| `transaction(run)` | Optional, async. Each write calls it. Take the lock, load the fresh snapshot (or `null`), call `run(fresh)`, save the snapshot that `run` returns, then release the lock. |
| `changed()` | Optional, sync. Each read calls it. When it returns `true`, the backend reloads with `load()`. |

Use `transaction` and `changed` when two processes share one snapshot. Without `transaction`, two processes that
write at the same time can overwrite each other's writes. The lock covers the full snapshot. When a save fails, the
backend puts its memory back to the disk state, and the write throws the error.

> **Caution:** With `transaction`, the backend write and admin methods return promises (`createStore`,
> `declareIndex`, `setIndexState`, `declareLedger`, `shred`, `setClock` and the others). Always `await` them. The
> `kvStore` methods are async in all modes.

> **Caution:** Do not call a backend write from inside `transaction`. It waits for its own lock and never ends.

The conformance suite README has a full example on a file, with a lock file and an atomic rename.

## Index settings

| Setting | Default | Meaning |
|---|---|---|
| `initialState` | `'BUILDING'` | `'ACTIVE'` makes a new index ACTIVE at once. The backfill check still runs, so an index can be `FAILED`. Use `'ACTIVE'` for local development. |
| `activationMs` | 75000 | The time a new index stays `BUILDING`, as on the platform. |
| `listLagMs` | 0 | A list by index leaves out an item until `listLagMs` after its last write, as the runtime can. `getBy` and `count` have no lag. A delete has no lag. |

`backend.setIndexState(storeId, name, 'ACTIVE' | 'BUILDING' | 'FAILED')` holds an index in a state until the next
call. Use it to test how a function handles `INDEX_NOT_READY`.

## Other backend controls

- `backend.ledgers(storeId)`: the ledgers of the store, `[{ name, state, activeAfter?, definition }]`. `state` is
  `'PENDING'`, `'ACTIVE'`, `'DROPPED'` or `'FAILED'`; `activeAfter` (ISO 8601) is only on a `PENDING` ledger;
  `definition` is the completed definition (with `personalFields`, and `subjectField`, `subjectMode` and `subjectCase`
  for a subject ledger).
- `backend.indexes(storeId)`: the indexes of the store, `[{ name, state, error?, definition }]`. `state` is
  `'BUILDING'`, `'ACTIVE'` or `'FAILED'`; `error` names the backfill error of a `FAILED` index; `definition` is the
  normalized definition.
- Both are reads: they bring each state up to the clock (and reload a changed snapshot first, with `changed()`),
  return copies, and throw `STORE_NOT_FOUND` for an unknown store. Use them instead of reading `snapshot()`.
- `backend.archiveNow(storeId)`: archive every ledger entry now, so `ledgerProof` returns a signed proof.
- `backend.injectFault({ op, when })`: the next call of `op` fails, `'before'` the write or `'after-write'`.
- `backend.setClock(ms)`: set the server time.
- `backend.snapshot()` and `backend.restore(snapshot)`: save and load the full state.

## Ledger subjects

The backend emulates the ledger subject contract, version 1, of the platform:

```js
await backend.declareLedger('site-data', {
  name: 'audit', collection: 'audit:*', chains: 1, retentionDays: 30,
  subjectField: 'userId', personalFields: ['email'], // subjectMode 'pseudonym' and subjectCase 'exact' by default
});
const store = kvStore.open('site-data');
const r = await store.append('audit:login', { userId: 'u-17', email: 'a@example.com' });
await store.get(r.key); // { userId: 'u-17', email: 'a@example.com' }

const done = await backend.shred('site-data', 'audit',
  { subjectId: 'u-17', reason: 'Erasure request 1', authority: 'Policy 4', requestedBy: 'Privacy officer' });
await store.get(r.key); // { userId: { $shredded: true }, email: { $shredded: true } }
backend.subjectEntries('site-data', 'audit', { subjectId: 'u-17' }); // { subjectState: 'shredded', shreds: [...], ... }
```

- `subjectMode`: `'pseudonym'` (default) stores a token in the subject field and the value as appended, sealed;
  `'clear'` keeps the field and stores the token in `$subjectTag`. `subjectCase`: `'exact'` (default) or `'fold'`.
  Both are immutable.
- Reads show the value as appended, or `{ $shredded: true }` after a shred. `ledger.subject` names the mode.
- `backend.shred(storeId, ledger, body)` and `backend.subjectEntries(storeId, ledger, body)` return the body of the
  platform routes `POST …/ledgers/{name}/shred` and `POST …/ledgers/{name}/subject-entries`. They are not on
  `kvStore`. The shred receipt is signed with the local key of `backend.publicKey()`.
- A ledger declared with a subject field by 0.1.x has no `subjectMode`. It now refuses appends and decrypted reads
  with `LEDGER_FORMAT_RETIRED`, as the platform does. Declare a new ledger.

The subject keys are local keys in the snapshot, not KMS keys. The conformance suite's
[docs/subject-v1-local.md](https://github.com/quantcdn/kv-ledger-conformance/blob/develop/docs/subject-v1-local.md)
lists what is emulated and what is not.

## Not in this version

- The shred has no 202 (in progress) answer, no subject reference key rotation and no forked stores. There is no
  subject preview, shreds list or receipt route.
- One lock covers all stores. There are no snapshots for each store.
- Each write with a storage hook makes one copy of the full snapshot (the one it saves), so the cost of a write
  grows with the size of the data. For many writes at once, use `atomic()` or one `backend.transact` call, or fill a
  backend without storage and save its `snapshot()` once.

## Licence

Apache-2.0. Copyright 2026 QuantCDN Pty Ltd.
