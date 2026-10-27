# Changelog

## Unreleased

- Storage hook: optional `storage.transaction(async (fresh) => next)`, so that two processes can share one snapshot
  with a lock, and optional `storage.changed()`, so that reads reload a changed snapshot. Without `transaction`,
  writes stay synchronous. A failed save puts the memory back to the disk state. `setClock` is now a write (it is
  in the snapshot). `storage` must have `load()` and `save()` or `transaction()`.
- Parity with the platform (edge-kv 0.1.0-rc.2): an index that is not declared gives VALIDATION `No index named
  <name>` (getBy, count, list by index, drop), not NOT_FOUND. The INDEX_NOT_READY and wrong-kind texts are the
  platform's. New case `core/indexes/unknown-index`.
- Parity with the platform (edge-kv 0.1.0-rc.1): item versions are ULIDs (26 characters of Crockford base32,
  monotonic in one process); the edge checks accept plain objects from another realm (for example a `node:vm`
  context); the FORBIDDEN message is `Access to KV store <id> is not allowed`. New case
  `core/conditional/version-shape`.
- `@quantcdn/edge-kv` (`packages/edge-kv`): the edge `kvStore` layer and the local backend as an npm package, with
  `createLocalKv()` and types.
- Index settings for the local backend and the reference adapter: `indexes.initialState` (`'BUILDING'` or
  `'ACTIVE'`), `indexes.activationMs` and `indexes.listLagMs`.
- `control.setIndexState(storeId, name, 'ACTIVE' | 'BUILDING' | 'FAILED')` on the reference adapter, and
  `backend.setIndexState`.

## 0.1.0 (unreleased)

First version. It covers the edge `kvStore` API surface of 2026-10-24 (store handle, iteration, `KVError` class,
`verifyChain`, `LEDGER_FORMAT_RETIRED`) and the KV ledger byte layout v1.

- Conformance cases: 158 cases in five groups. `bytes` (9), `core` (114), `ledger` (26), `proof-timing` (3) and the
  disabled `subject-v1` group (6).
- Runner and CLI: `run()` and `node run.mjs` (bin `kv-conformance`), with tags, the version gate, include and exclude
  prefixes, shapes, timeouts and a JSON report that names the API surface (`apiSurface`).
- Golden vectors: `vectors/ledger-vectors.json` for the ledger byte layout, and `lib/ledger-bytes.mjs`.
- Limits (`lib/limits.mjs`) and the error contract (`lib/error-contract.mjs`, 37 error codes).
- Reference adapter: an in-memory edge layer over a local backend, with a virtual clock, indexes, transactions,
  ledgers, a simulated signed archive, sealed personal fields, secret values, fault injection and a storage hook.
- Edge harness adapter: an edge function body and a proxy `kvStore`, to run the cases on the real edge runtime.
- Public API adapter: the `kvStore` over the public KV v2 HTTP API, with a rate cap (default 3 requests per second).
- Offline verifier: archive, inclusion proof, signed document and purge checks (bin `kv-ledger-verify`, export
  `./verifier`).
- Exports for emulators: `createLocalBackend` from the reference adapter; `createEdgeCalls`, `createEdgeChecks`,
  `createKVErrorClass` and `buildKvStore` from the main entry.
- Timeouts for a real platform: an adapter `defaultTimeoutMs`, the CLI option `--timeout-ms`, the activation delay for
  each declaration in a case's `declares`, and a separate setup timeout (a setup failure is `error`).
- Self-checks: mutation checks (broken adapters make named cases fail, each for a named reason) and a public-safety
  scan of every file (generic patterns, plus a private list from `KVC_SAFETY_DENYLIST`).
