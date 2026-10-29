# KV conformance suite — design

Date: 2026-10-25. Repository `quantcdn/kv-ledger-conformance` (public, Apache-2.0). The suite is at the repository root; the offline verifier is in `verifier/`; the golden vectors are in `vectors/`.

## 1. Purpose and consumers

A public, vector-driven conformance suite for the Quant edge `kvStore` API and KV v2 ledgers. It runs against any
implementation through a small adapter. It contains no Quant internals.

Consumers:

1. The real edge runtime, through an edge function harness (owner-run against a test platform).
2. A local emulator for `quant serve`. It runs the suite under mocha in CI.
3. A third-party self-run reference ledger, with its own adapter under `node:test`, or over the public KV v2 HTTP API.

Contract sources, in order of authority: `kvstore.d.ts` (edge types, 2026-10-24 surface: handle, iteration,
`KVError` class, `verifyChain`, `LEDGER_FORMAT_RETIRED`), the customer page "Edge function KV store API", the docs pages `compute/kv-stores.md`
and `compute/kv-ledgers.md`, and `vectors/ledger-vectors.json` (byte layout).
Where they disagree, the suite follows `kvstore.d.ts` and the README lists the drift (section 12).

## 2. Constraints

- ESM, Node 20 or later, standard library only, no dependencies. Library (`import { run } from
  './index.mjs'`) and CLI (`node run.mjs`).
- Public-safe: no internal host names, account ids, secret or actor header names, table names, backend route paths
  of the internal management API, or security-sensitive runtime internals. A test of the suite scans the tree for a
  deny-list of patterns (section 11).
- Credentials only from environment variables. Never logged, never in a report, never in an error message.
- Licence: Apache-2.0 (`LICENSE`, `NOTICE`). `package.json`: name `@quantcdn/kv-ledger-conformance`,
  `"license": "Apache-2.0"`. Every source file starts with `// SPDX-License-Identifier: Apache-2.0` (after a shebang).
- Version: `SUITE_VERSION = '0.2.0'` (semver), tied to the KV release: 0.x until the KV v2 release ships to
  production, then the major and minor follow the KV API release the suite covers. `VALIDATED_AGAINST = []`: a list of `{ target, build, date, result }`
  that the owner fills in after a run against a real build. The JSON report states both.

## 3. Adapter interface

An adapter module exports `async function createAdapter(options)`. `options` is `{ clock }`, a virtual clock created
by the runner. The result:

```js
{
  name: 'reference',                 // free text, in the report
  kvStore,                           // the edge kvStore object: what an edge function sees as `kvStore`
  shapes: ['global', 'handle'],      // call shapes the adapter supports (section 4.3)
  clock,                             // the clock in use: options.clock, or the adapter's own real clock
  capabilities: {                    // false or missing = not supported; a case that needs it is SKIPPED
    virtualClock, eventualIndexLists, indexBuildStates, proofTiming, signedProofs,
    search, secretEncryption, subjectV1, setClock, advanceArchive, injectFault,
  },
  admin: {                           // outside the edge surface
    createStore({ format: 2 }) -> { storeId, identity: { org, store } },  // fresh, empty, allowed for kvStore
    declareIndex(storeId, def, { wait = true }) -> { name, state },      // wait: resolve when ACTIVE
    dropIndex(storeId, name),
    declareLedger(storeId, def, { wait = true }) -> { name, state, definition, definitionHash, activeAfter? },
    dropLedger(storeId, name),
    proofPublicKey(storeId) -> PEM string,     // only with capabilities.signedProofs
    dispose(),                                 // release everything the adapter created
  },
  control: {                         // optional hooks; present only when the matching capability is true
    setClock(ms),                    // server time for ULID and `at`
    advanceArchive(storeId),         // archive every unarchived entry now (pending -> archived)
    injectFault({ op, when }),       // the next call of `op` fails: 'before' (nothing written) or
                                     // 'after-write' (written, response lost: UNAVAILABLE with outcome unknown)
  },
}
```

Capability meanings:

| Flag | Meaning when true |
|---|---|
| `virtualClock` | `clock.advance(ms)` is instant and drives TTL expiry, the idempotency replay window, index build states, ledger activation and archiving. |
| `eventualIndexLists` | A list by index can miss a write made just before it (the runtime). Cases then poll with `clock.advance`. |
| `indexBuildStates` | `declareIndex(..., { wait: false })` leaves the index `BUILDING`, and a query throws `INDEX_NOT_READY`. |
| `proofTiming` | `ledgerProof` moves from `pending` to `archived` when the archive runs (by `advanceArchive` or by time). |
| `signedProofs` | An archived proof carries `digest`, `signature` and an audit path, verifiable with `admin.proofPublicKey`. |
| `search` | `search()` is implemented. |
| `secretEncryption` | `set(..., { secret: true })` stores an encrypted value (`encrypted: true`, `[ENCRYPTED]` in lists). |
| `subjectV1` | Ledger subject pseudonym mode, version 1 (section 8). |
| `shortPages` | The page scan budget is at most `limits.shortPagesBudgetMax` (10) rows, so a page can be empty with `hasMore: true`. |
| `setClock`, `advanceArchive`, `injectFault` | The matching control hook exists. |

`definition` in the ledger declare: `{ name, collection, chains, retentionDays, lockMode?, personalFields?,
subjectField?, subjectMode?, subjectCase?, anchor? }`. The adapter completes it (`v: 1`, defaults, `createdAt`) and
returns the full definition and its `definitionHash` (SHA-256 of the JCS bytes). The suite uses `identity`,
`definitionHash`, the collection and the shard to recompute the genesis `prevHash` (section 7).

## 4. Cases

### 4.1 Case format

Cases are data. `cases/index.mjs` exports `cases`, an array of:

```js
{
  name: 'core/set-get/json-round-trip',  // unique, '/'-separated, stable (reports and filters use it)
  tags: ['core'],                        // one group tag, plus optional 'message-exact'
  needs: ['secretEncryption'],           // capability flags; any false -> SKIPPED
  shapes: ['global', 'handle'],          // optional; default both. A case runs once per shape the adapter has.
  adapter: true,                         // false for pure byte-layout cases (no adapter, run once)
  declares: ['ledger'],                  // optional: 'ledger' and 'index' declarations the case waits for
  timeoutMs: 30000,                      // optional; overrides the computed timeout
  async run(ctx) { ... },                // throws an AssertionError (node:assert) to fail
}
```

The suite runs under `node:test` or mocha through `run()` (section 5), or a host can iterate `cases` itself.

### 4.2 The case context

`run(ctx)` receives a fresh store per case and shape:

- `ctx.kvStore` — the adapter's kvStore (global shape).
- `ctx.kv` — a store view for the current shape. Handle shape: `kvStore.open(storeId)`. Global shape: a binder whose
  methods call `kvStore.<method>(storeId, ...args)`, with one mapping: `kv.get(key, { raw: true })` becomes
  `kvStore.get(storeId, key, true)`. Cases that test handle-only rules declare `shapes: ['handle']`.
- `ctx.storeId`, `ctx.identity` (`{ org, store }`), `ctx.admin`, `ctx.control`, `ctx.clock`, `ctx.caps`, `ctx.shape`.
- `ctx.limits` (section 6), `ctx.expectKVError(promiseOrFn, expected)` (section 6.2), `ctx.ledgerBytes` (section 7),
  `ctx.uniqueKey(prefix)` (a key unique in the run, made of `[A-Za-z0-9_-]`).

### 4.3 Groups and tags

| Tag | Default | Content |
|---|---|---|
| `bytes` | on | Pure byte-layout vectors, no adapter: JCS definition hash, genesis hash, entry hash, Merkle root and audit paths, digest genesis, source chain. |
| `core` | on | get/set/delete, getEntry/getMany, conditional writes, TTL, increment, atomic, list/search, collections, cursors, iteration, handle, KVError, error contract, limits, indexes. |
| `ledger` | on | append, receipts, idempotency replay, chains, list since/until, status, verifyChain, immutability, ledger errors, proof `pending`. |
| `proof-timing` | off (slow) | proof `pending` -> `archived`, signed proof checks. |
| `subject-v1` | off, needs `--enable subject-v1` | subject pseudonym mode, version 1 of the subject contract. |
| `message-exact` | off | Exact message text. Never mixed into another case: a case with this tag checks only messages. |

Each result has a status: `pass`, `fail`, `skip` (with the reason: a missing capability or shape, or a disabled tag) or
`error` (the adapter threw outside an assertion: setup failure). A skipped case is never counted as passed.

## 5. Runner and CLI

`run({ adapter, tags, enable, include, exclude, shapes, timeoutMs, onResult })`:

- `adapter`: the module (an object with `createAdapter`) or a path.
- `tags`: the tags to run (default `['bytes', 'core', 'ledger']`). `enable`: version-gated groups to switch on
  (`subject-v1`). A `subject-v1` case runs only when both its tag is selected and it is enabled.
- `include`/`exclude`: name prefixes.
- One adapter instance per run (`createAdapter` once, `admin.dispose()` at the end). One fresh store per case and shape.
- Each case has a timeout. A case `timeoutMs` wins. Else the base timeout is the run option `timeoutMs` (CLI
  `--timeout-ms`), else the adapter's `defaultTimeoutMs`, else 30 s. A case adds `limits.ledgerActivationMs` or
  `limits.indexActivationMs`, plus `limits.activationMarginMs`, for each entry in its `declares`. A timeout is a `fail`.
- Setup (the store and the context) has its own timeout, equal to the base timeout. A setup failure or a setup
  timeout is an `error`. The case timer starts after setup.
- Returns the report:

```json
{ "suite": "kv-conformance", "version": "0.2.0", "apiSurface": "...", "validatedAgainst": [], "adapter": "reference",
  "capabilities": { "...": true }, "shapes": ["global", "handle"], "tags": ["bytes", "core", "ledger"],
  "startedAt": "...", "durationMs": 1234,
  "summary": { "total": 0, "pass": 0, "fail": 0, "skip": 0, "error": 0 },
  "results": [ { "name": "...", "tags": [], "shape": "handle", "status": "pass", "ms": 3, "reason": "..." } ] }
```

CLI: `node run.mjs --adapter <path> [--tags core,ledger] [--enable subject-v1] [--include <prefix>]
[--exclude <prefix>] [--timeout-ms <ms>] [--json <file>] [--list]`. Exit 0 when no `fail` or `error`, 1 otherwise, 2 for bad input.
`--list` prints the case names and tags without running. The human output prints one line per result.

## 6. Limits and the error contract

### 6.1 Limits

`lib/limits.mjs` exports one frozen object. Each value cites its source. Values:

| Name | Value | Source |
|---|---|---|
| `storeId` | `/^[A-Za-z0-9_-]{1,255}$/` | API page |
| `keyMaxBytes` | 2048 | API page |
| `idMaxBytes` (format 2, text after the last `:`) | 1000 | API page |
| `itemMaxBytes` | 400 KB (409,600) | API page |
| `ttl` | `{ min: 60, max: 31536000 }` | d.ts |
| `expiryOptionNames` | expiration, expirationTtl, expires, expiresAt, expiresIn, ttlSeconds, maxAge; hint `use ttl (seconds)` | d.ts |
| `getMany` | `{ minKeys: 1, maxKeys: 100, maxBytes: 4 MiB }` | d.ts, backend batch-get |
| `transaction` | `{ minOps: 1, maxOps: 25 }` | d.ts |
| `idempotencyKey` | `/^[A-Za-z0-9_-]{1,64}$/`, replay window 24 h, auto key `/^q_[0-9a-f]{32}$/` | d.ts |
| `listLimit` | `{ min: 1, max: 1000, default: 25 }` | d.ts |
| `pageBytesEdge` | 4 MiB (4,194,304) | d.ts |
| `pageBytesBudget` | 4,000,000 | backend page budget (stays under the edge cap) |
| `scannedRowsPerPage` | 10,000 | d.ts |
| `shortPagesBudgetMax` | 10 | suite: the largest page scan budget that the `shortPages` capability means |
| `pageEnd` | `['limit', 'bytes', 'budget', 'end']` | d.ts |
| `maxPages` | `{ min: 1, max: 100, default: 10 }` | d.ts |
| `verifyChainMaxEntries` | 10,000 | d.ts |
| `prefixPattern` | `{ min: 1, max: 512 }` characters | d.ts |
| `whereFields` | `{ min: 1, max: 8 }` | d.ts |
| `equalsFields` | `{ max: 3 }` | d.ts |
| `cursorLifetimeMs` | 24 h | d.ts |
| `ledgerCollectionMaxBytes` | 512 | d.ts |
| `ledgerValueMaxBytes` | 350,000, measured on the stored envelope including `source` | backend append (`checkSize(storedEnvelope(value, source))`) |
| `ledgerChains` | `{ min: 1, max: 64 }` | ledgers page |
| `ledgerName`, `indexName` | `/^[A-Za-z][A-Za-z0-9_]{0,63}$/` | ledgers and stores pages |
| `ledgerActivationMs` | 75,000 | ledgers page |
| `activationMarginMs` | 15,000 | suite: the time a case allows over an activation delay (section 5) |
| `archivePeriodMs` | 300,000 | ledgers page |
| `timeoutsMs` | `{ default: 8000, append: 11000 }` | API page |

`ledgerValueMaxBytes` was checked in the backend source: the size check runs on the stored envelope string, which
holds `source`. `getMany.maxKeys` was checked in the runtime and backend source (100). At the edge, more than 100 keys
is `VALIDATION` before any request.

### 6.2 Error contract

`lib/error-contract.mjs` exports `ERROR_CODES`: one row per `KVErrorCode` of the d.ts (37 codes), with `status`
(number, or `null` when the d.ts gives none), `retryable` (`true`, `false`, or `'varies'`), and `details` (the detail
fields the d.ts names for that code). `DETAIL_FIELDS` lists the 16 detail fields of the `KVError` interface.

`ctx.expectKVError(target, expected)` awaits `target` (a promise or a function), requires a throw, and checks:

1. `err instanceof ctx.kvStore.KVError` and `err.name === 'KVError'`.
2. `err.code === expected.code` (or `expected.code` is an array of allowed codes).
3. `err.retryable === expected.retryable` when given, else the contract value when it is boolean.
4. `err.status`: when given in `expected`, it must equal. Otherwise, when present on the error and the contract has a
   status, it must equal the contract status. (An edge-created `VALIDATION` may have no status.)
5. Each field in `expected.details` (`{ field: value }` exact, or `{ field: 'string' | 'number' | 'present' | RegExp }`).
6. Every detail field present on the error is a scalar (`string` or `number`), per the d.ts.

Never the message text. `message-exact` cases use `expected.message` (a string or RegExp), and only they do.

## 7. Byte layout and the identity

`lib/ledger-bytes.mjs` implements, from the ledgers page: `sha256Hex`, `canonicalJson` (JCS), `instanceName(org, store,
collection, shard)`, `genesisHash(instance, definitionHash)`, `entryHash({ prevHash, instance, seq, id, at, stored })`,
`digestGenesisHash(org, store)`, `merkleRoot(hashes)`, `auditPath(index, hashes)`, `rootFromAuditPath(leaf, index, n,
path)`, `definitionHash(definition)`. It is independent code from `verifier/lib/`; tests check both against the one vector file `vectors/ledger-vectors.json`.

Ledger cases use the identity: for `seq` 1 on a shard, `receipt.prevHash === genesisHash(instanceName(identity.org,
identity.store, collection, receipt.shard), definitionHash)`. `shard` is a two-digit string `00`-`63`. `at` is epoch
milliseconds. `seq` and `prevHash` chain per shard.

Signed proof check (`lib/proof-check.mjs`, used by `proof-timing` cases with `signedProofs`): (1) the entry hash
recomputes from `entry` with the instance built from `digest.org`, `digest.store`, `entry.collection`, `entry.shard`, and
equals `hash`; (2) `auditPath` from `hash` at `leafIndex` in `treeSize` folds to `merkleRoot`; (3) `digest.ledgers[].
instances[]` has an instance with the proof's `archiveKey` and that `merkleRoot`, for the entry's collection and shard,
with `leafIndex = seq - fromSeq` and `treeSize = toSeq - fromSeq + 1`; (4) `signature` (base64 DER ECDSA P-256) verifies
over SHA-256 of `canonicalJson(digest)` with `admin.proofPublicKey(storeId)`. The real platform key check is `verifier/verify.mjs verify-proof`.

## 8. subject-v1 group (version-gated)

Versioned group for the ledger subject pseudonym contract. It runs only with `--tags subject-v1` and `--enable
subject-v1`. The reference adapter passes it (`subjectV1: true`; what the local backend emulates is in
[subject-v1-local.md](subject-v1-local.md)). Contents: `fixtures/subject-v1-vectors.json` (the canonicalisation vectors of the design: `" Alice@Example.COM "`
→ exact `"Alice@Example.COM"`, fold `"alice@example.com"`; `"é"` → NFC `"é"`; `"\uD800"` → VALIDATION; `42` → `"42"`; `4.5` →
VALIDATION) and adapter cases on what the edge observes: declare with `subjectField` and `subjectMode: 'pseudonym'`;
append and read back shows the subject as appended; `ledger.subject` is `'pseudonym'` on reads; `$subject` and
`$subjectTag` are reserved (VALIDATION); a subject value of a bad type (a float) is VALIDATION; 42 and "42" are one
subject (an index list by the subject field with `equals` finds both). Each case states `subjectContract: 1`.

## 9. Reference adapter (`adapters/reference/`)

In-memory, for the emulator and for the suite's own tests. Clearly not production: no durability guarantee, no
access control beyond the store allow-list, local keys only. It passes `bytes`, `core`, `ledger`, `proof-timing` and
`subject-v1` (`subjectV1: true`; see [subject-v1-local.md](subject-v1-local.md)).

### 9.1 Two layers: edge layer and local backend

The reference adapter is two layers, so the local backend can later become (or be replaced by) the one local
backend behind a shared pure KV client package:

- **Edge layer** (`lib/edge-surface.mjs`, `lib/edge-checks.mjs`): argument and option checks, iteration, `open`,
  `verifyChain`, the `KVError` class. It calls the backend and nothing else.
- **Local backend** (`adapters/reference/backend/`): `createLocalBackend({ clock, seed, budgetRows, keys, storage })`
  returns an object with store-id-first methods that take already-checked arguments and return plain data or throw
  `KVError` with the store-level status: `createStore({ id, format })`, `deleteStore`, `get`, `put`, `remove`,
  `increment`, `batchGet`, `transact(ops, { idempotencyKey })`, `query(options)` (one page), `declareIndex`,
  `dropIndex`, `lookup`, `count`, `declareLedger`, `dropLedger`, `append`, `ledgerStatus`, `ledgerProof`,
  `shred(storeId, ledger, body)` and `subjectEntries(storeId, ledger, body)` (the platform's subject routes),
  `archiveNow(storeId)`, `publicKey()`, `injectFault({ op, when })`, `snapshot()` and `restore(snapshot)` (a JSON-safe
  copy of every store, index, ledger, idempotency record, archive and the clock offset; `storage` is an optional
  `{ load(): snapshot | null, save(snapshot) }` hook called at create and after each write).
- The backend covers: formats (format 2 in full; format 1 accepted at create, with the format 1 query behaviour
  deferred), versions, indexes with build timers on the injected clock, TTL, transaction idempotency (24 h), list
  limits and budgets, ledgers with the hash chain, a simulated archive (5-minute periods, injected clock, archive-now),
  a local P-256 signing key, the ledger subject contract version 1 (pseudonym and clear modes, subject references and
  key generations, shreds with signed receipts) with AES-256-GCM sealing of personal fields per subject key (the
  `$enc`, `iv`, `tag` envelope of the byte layout; reads open them), secret values encrypted with a local AES-256-GCM key, and fault
  injection.
- The backend never imports the edge layer. The adapter is `buildKvStore(backendCalls, KVError)` plus `admin` and
  `control` mapped onto the backend.

Behaviour follows the contract sources. Rules worth naming:

- Validation at the edge layer (options, arguments, limits) happens before any store work and throws `VALIDATION`
  without `status`; store-level errors carry the documented status.
- Format 2 for every case (`createStore({ format: 2 })`). Collections: text before the last `:`.
  Collection lists in UTF-8 byte order of the id. Versions: opaque strings, new on every write.
- TTL by `clock.now()`. Expired keys read as null and are omitted from lists; `ifAbsent` treats them as absent;
  `ifVersion` fails with `reason: 'expired'`.
- Unknown `set`/`delete` options: expiry-like names throw `VALIDATION` with `hint`; other names are ignored (warn
  phase). Cases accept both phases for non-expiry names.
- Cursors: opaque, bound to the store and the query options except `limit`, valid 24 h of `clock`; else `CURSOR_INVALID`.
- Pages: `limit` items, `pageBytesBudget` bytes (a page ends early with `pageEnd: 'bytes'`, at least one item), and a
  scan budget (`pageEnd: 'budget'` can give an empty page with `hasMore: true`). The reference adapter exposes a test-only
  `budgetRows` option in `createAdapter` (default 10,000) so a case group can force short pages; cases that need it
  declare `needs: ['shortPages']` and the reference adapter sets `capabilities.shortPages` only when `budgetRows` is
  at most `limits.shortPagesBudgetMax` (10). The `core/iteration/short-pages` case uses three times that many items.
- Indexes: plain, unique, count; states `BUILDING` → `ACTIVE` when `wait` or after 75 s of clock; `INDEX_NOT_READY`
  before; `UNIQUE_VIOLATION` with `index` and `existingKey`; `COUNT_WITH_TTL`; `INDEX_FIELD_ENCRYPTED`; `getBy` on a
  non-unique index and `count` on a non-count index are `VALIDATION`. Index lists are strongly consistent here.
- Ledgers: declare → `PENDING` with `activeAfter` (ISO string) 75 s later; `wait: true` advances the virtual clock to
  `activeAfter`. Appends: shard chosen by a seeded generator, `id` = 26-char ULID of `at` + `-` + shard, `key` =
  `collection:id`, stored envelope `{"type":"plaintext","value":<value>,"source":{"type":"edge","principal":
  "<org>/local/reference"}}`, hashes per section 7. Idempotency per store, 24 h; same key with a different collection or
  value is `VALIDATION`; without a key the adapter generates `q_` + 32 hex and puts it on any error. Immutability:
  `LEDGER_IMMUTABLE` for set/delete/increment/atomic on a ledger key. Dropped ledger: `LEDGER_DROPPED`. Archive: per
  shard per 5-minute period, signed digest (local P-256 key) and proof as section 7.
- `injectFault`: `before` throws `UNAVAILABLE` (retryable as documented) and writes nothing; `after-write` performs
  the write and then throws `UNAVAILABLE` (append with a key: `retryable: true`; increment: `retryable: false`;
  commit: `retryable` only with an `idempotencyKey`).

## 10. Runtime adapters

### 10.1 Edge harness (`adapters/edge-harness/`)

- `harness-fn.js`: an edge function body (the runtime wraps it as `async function (event, kvStore, ...)`; the same
  shape as a validation function on a test platform). It accepts `POST` with a JSON body `{ token, calls: [{ shape, storeId, method,
  args, iterate? }] }` and answers `{ results: [{ ok, value } | { ok: false, error: { name, code, status, retryable,
  instanceOfKVError, message, ...details } }] }`. `iterate` is `{ mode: 'items' | 'pages' | 'asyncIterator', options? }`:
  the harness runs the iteration inside the function and returns the collected items or pages, or the error with its
  `cursor`. `verifyChain` is synchronous in the d.ts, so the adapter runs it locally, not in the function. `atomic` is sent as `{ method: 'atomic', ops: [...], commit:
  {...} }`. The token is a placeholder `__HARNESS_TOKEN__` that the owner replaces at deploy time. A wrong or missing
  token answers 403. A token that is not configured (the placeholder, or under 32 characters) answers 503. Neither
  makes a `kvStore` call.
- `index.mjs`: `createAdapter` returns a proxy `kvStore` whose methods send one call each (via `fetch`) and rebuild a
  local `KVError` (its own class, exposed as `kvStore.KVError`) from the error fields. `list`/`search` return a
  thenable with `pages()`/`items()`/`[Symbol.asyncIterator]` that send one `iterate` call. Admin goes through the public
  API client (10.2). Env: `KVC_HARNESS_URL`, `KVC_HARNESS_TOKEN`, plus the 10.2 variables.
  Capabilities: `virtualClock: false`, `eventualIndexLists: true`, `indexBuildStates: true`, `proofTiming: true`,
  `signedProofs: true` (the public key from the public-key operation), `search: true`, `secretEncryption: true`, no
  control hooks. Its clock is real: `advance(ms)` sleeps, allowed only in `proof-timing` cases.
- The suite tests the harness by running `harness-fn.js` in Node against the reference adapter's `kvStore` behind a
  local HTTP server.

### 10.2 Public API (`adapters/http/`)

- `lib/public-api.mjs`: a client for the public KV v2 API (public API spec 4.28.0, operationIds `KV_create`, `KV_show` (store readiness), `KV_delete`,
  `KV_entries_show`, `KV_entries_put`, `KV_entries_delete`, `KV_items_increment`, `KV_items_batch_get`,
  `KV_items_transact`, `KV_keys_list`, `KV_indexes_create`, `KV_indexes_show`, `KV_indexes_delete`,
  `KV_indexes_lookup`, `KV_indexes_count`, `KV_ledgers_create`, `KV_ledgers_show`, `KV_ledgers_delete`,
  `KV_ledgers_append`, `KV_ledgers_status`, `KV_ledgers_proof`, `KV_ledgers_public_key`). Base URL, org, project and
  token from env (`KVC_API_BASE`, `KVC_ORG`, `KVC_PROJECT`, `KVC_API_TOKEN`). A token-bucket rate cap
  (`KVC_RATE` requests per second, default 3). The token is sent as a bearer token and never logged; errors are mapped
  to `KVError` from the documented error body (`code`, `message`, detail fields).
- `index.mjs`: `createAdapter` builds a `kvStore` over the client with the suite's edge surface (`lib/edge-surface.mjs`:
  iteration, `open`, `verifyChain`, `KVError`) and the same edge-layer argument checks as the reference adapter
  (`lib/edge-checks.mjs`, shared). Admin: create a format 2 store per `createStore`, delete it in `dispose` (a store
  with a ledger cannot be deleted: listed in the dispose report).
- `secretEncryption` is false for this adapter: the public API never returns a secret value (a read gives
  `[ENCRYPTED]`). Other gaps (raw text, first status page only, no `scannedCount`, sealed personal fields) are listed
  in the README.
- Tested against a small fake server in the test folder (a handful of operations), never against a real host.

## 11. Tests of the suite (`node --test`)

- Byte layout vs vectors; vector files identical to the verifier's.
- Limits and error contract vs a copy of the d.ts error-code list (`fixtures/kvstore-error-codes.json`, generated once
  from the d.ts text and checked in).
- Runner: tags, enable gate, shapes, skip reasons, timeouts, report shape, CLI exit codes.
- Edge surface: iteration, page cap, LIMIT_EXCEEDED with cursor, verifyChain problems, handle get options.
- The reference adapter passes every `bytes`, `core`, `ledger` and `proof-timing` case (zero `fail`, zero `error`).
- Mutation checks: small broken adapters (wrapping the reference) make specific cases fail, so the cases assert
  something (for example a `get` that returns `undefined` for a missing key, a receipt with a wrong `prevHash`, an error
  without `retryable`).
- Harness: `harness-fn.js` behind a local server, driven by the edge-harness adapter, passes a core subset.
- HTTP adapter against the fake server: a few calls, the rate cap, the token not in any output.
- Public-safety scan: no tracked file matches the deny-list in `test/public-safety.test.mjs`. The tracked list is
  generic only: cloud provider hosts and resource names, ARNs, account-id shaped numbers in an ARN or account
  context, and local paths. The test file builds each pattern from parts, so it does not match itself. Maintainers add
  a private list (one regular expression per line) from an untracked file named by `KVC_SAFETY_DENYLIST`.

## 12. Known drift between sources (reported, not decided here)

- Collection list `limit` is 1–100 on the stores and ledgers pages, 1–1000 in the d.ts and the backend page limits.
  The suite uses 1–1000.
- The format 2 read budget on the stores page (2,000 rows, 20 requests, 4 s) differs from the d.ts scan cap (10,000
  rows). The suite tests only the behaviour (a short page with `hasMore: true` continues), not the number.
- An append to a dropped ledger: the ledgers page says `LEDGER_IMMUTABLE`; the d.ts and the checks on a test platform say
  `LEDGER_DROPPED` (409). The suite requires `LEDGER_DROPPED`.

- The d.ts example `atomic().check('k', null).set('k', 1)` uses one key twice; the backend refuses a key that
  appears twice in a transaction (`VALIDATION`), as the stores page says. The suite follows the backend.

- The stores page says an invalid list option rejects with a plain `Error`; the d.ts says every error is a
  `KVError`. The suite requires `KVError` `VALIDATION`.

- Dropping an `ACTIVE` ledger before its retention ends: the ledgers page says `LEDGER_RETAINED`; the case
  `ledger/dropped` drops an empty `ACTIVE` ledger at once and requires `LEDGER_DROPPED` on a later append. To be
  confirmed on a live platform.

## 12a. Scope and target

The repository holds the offline ledger verifier (usable on its own: `verifier/`, its own entry point and bin), the
golden vectors, and the KV and ledger conformance suites. One target: the production surface as it will be (the
current development surface, including the kvStore improvements, and subject-v1 once stable).

## 13. Deferred

- Out of scope for this repository (owner decision): rule, static and function vectors. Edge vectors live in
  another team's repository.
- Format 1 cases (null/false on failure, legacy scan lists). The local backend accepts format 1 stores already.
- `subject-v1` cases: on by default only after the subject contract is released and the owner enables them; until
  then they need `--enable subject-v1`.
- Store upgrade, export and verify reports, and shred cases: management surface, not edge. (The local backend
  emulates the shred and the subject entries routes; no case uses them.)
