# Changelog

## Unreleased

### 0.2.0

Suite and `@quantcdn/edge-kv` 0.2.0. Minor: a new feature.

- The local backend emulates the ledger subject contract, version 1, of the platform
  ([docs/subject-v1-local.md](docs/subject-v1-local.md)). `declareLedger` takes `subjectMode` (`'pseudonym'` by
  default, or `'clear'`) and `subjectCase` (`'exact'` by default, or `'fold'`) with a `subjectField`, and both enter
  the hashed definition. In `pseudonym` mode the subject field stores a token and a sealed `$subject`; reads show the
  value as appended, or `{ $shredded: true }` after a shred, and `ledger.subject` names the mode. Lists by index
  `equals` and `where` find a subject by its live token. The subject id is canonicalised as
  `fixtures/subject-v1-vectors.json` says. The texts of the subject errors are the platform's.
- New backend calls `shred(storeId, ledger, { subjectId, reason, authority, requestedBy })` (shred entries, then the
  key is destroyed, with a signed `kv-ledger-shred-receipt`) and `subjectEntries(storeId, ledger, body)`. They return
  the bodies of the platform routes `POST …/ledgers/{name}/shred` and `POST …/ledgers/{name}/subject-entries`. The
  reference adapter has them as `admin.shred` and `admin.subjectEntries`.
- Index rules against ledgers, in both orders: a ledger collection takes plain indexes only (`LEDGER_INDEX_KIND`), an
  index cannot use a personal field (`INDEX_FIELD_ENCRYPTED`) or sort by a subject field (`VALIDATION`), and an index
  on the subject field of a pseudonym ledger must lie within its collection (`LEDGER_INDEX_KIND`).
- An idempotency key used before its subject was erased is `VALIDATION` with the platform message.
- Breaking for stored data: a ledger declared with a `subjectField` by 0.1.x has no `subjectMode`. It now refuses
  appends and decrypted reads with `LEDGER_FORMAT_RETIRED`, as the platform does. Declare a new ledger.
- The append reserved-field errors use the platform texts.
- The reference adapter has `subjectV1: true` and passes the `subject-v1` cases (`--tags subject-v1 --enable
  subject-v1`).
- Storage hook: a write makes one copy of the snapshot (the one it saves), not two. A failed save goes back to
  `load()`, the fresh snapshot of the transaction, or the snapshot last saved or loaded; the backend takes a copy
  before a write only when there is no disk state yet.

### 0.1.x

- `@quantcdn/edge-kv` 0.1.1: an unknown option error says `Unknown <kind> option: <name>`, as the runtime does
  (was `<name> is not an option`). The ttl hint for expiry-like names is unchanged. `core/ttl/expiry-like-names`
  now checks the text.

- Public API adapter: `dispose` stops after `KVC_DISPOSE_MS` (default 5 minutes) and names the stores it did not
  delete (`DISPOSE_DEADLINE`). Before, a full run could wait more than an hour on the kv-admin rate limit.

- `@quantcdn/edge-kv` 0.1.0: the same code as 0.1.0-rc.2. The README names the cost of a write with a storage hook.

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
