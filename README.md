# kv-ledger-conformance

A conformance suite for the Quant edge `kvStore` API and KV v2 ledgers, with an offline ledger verifier.

The package holds three parts:

- **The KV and ledger conformance suites.** Cases that run against any implementation of the edge `kvStore`
  surface through a small adapter.
- **The golden vectors.** `vectors/ledger-vectors.json` fixes the ledger byte layout: definition hash, genesis
  hash, entry hash, Merkle root, audit paths and the digest genesis.
- **The offline verifier.** `verifier/` checks downloaded ledger archives, inclusion proofs and signed documents.
  It works on its own (see [The offline verifier](#the-offline-verifier)).

The suite has one target: the production edge `kvStore` surface as it will be. That is the current development
surface (store handle, iteration, the `KVError` class, `verifyChain`), and the ledger subject contract (`subject-v1`)
when it is stable.

The suite is for these implementers:

- A local emulator for `quant serve`. It runs the suite in CI, for example under mocha.
- A third-party self-run reference ledger. It runs the suite under `node:test`, with its own adapter or with the
  public API adapter.
- Quant. It runs the suite against the real edge runtime through the edge harness.

The package uses only the Node.js standard library. It needs Node 20 or later and has no dependencies.

## Contents

- [Quick start](#quick-start)
- [The adapter interface](#the-adapter-interface)
- [Cases](#cases)
- [Use it from node:test or mocha](#use-it-from-nodetest-or-mocha)
- [The reference adapter](#the-reference-adapter)
- [Run against the real edge runtime (edge harness)](#run-against-the-real-edge-runtime-edge-harness)
- [The public API adapter](#the-public-api-adapter)
- [Tags and groups](#tags-and-groups)
- [The report](#the-report)
- [Limits and the error contract](#limits-and-the-error-contract)
- [Known drift between sources](#known-drift-between-sources)
- [Deferred](#deferred)
- [Versioning](#versioning)
- [The offline verifier](#the-offline-verifier)
- [Contributing](#contributing)
- [Licence](#licence)

## Quick start

Run the tests of the suite itself:

```sh
npm test
```

Run the cases against the in-memory reference adapter:

```sh
node run.mjs --adapter adapters/reference/index.mjs
```

The default tags are `bytes`, `core` and `ledger`. The output has one line for each result, then a summary:

```text
PASS  core/kv/get-missing-null [global]  (0 ms)
PASS  core/kv/get-missing-null [handle]  (0 ms)
...
reference: 295 total, 285 pass, 0 fail, 10 skip, 0 error
```

CLI options:

```text
node run.mjs --adapter <path> [--tags core,ledger] [--enable subject-v1] [--include <prefix>]
             [--exclude <prefix>] [--timeout-ms <ms>] [--json <file>] [--list]
```

| Option | Meaning |
|---|---|
| `--adapter <path>` | The adapter module (a file that exports `createAdapter`). |
| `--tags <a,b>` | The tags to run. Default `bytes,core,ledger`. |
| `--enable subject-v1` | Switch on a version-gated group. A `subject-v1` case runs only when its tag is selected and it is enabled. |
| `--include <prefix>` | Run only the cases whose name starts with the prefix. |
| `--exclude <prefix>` | Do not run the cases whose name starts with the prefix. |
| `--timeout-ms <ms>` | The base timeout of a case. Default: the adapter's `defaultTimeoutMs`, else 30 s. A case that declares a ledger or an index gets the activation delay and a margin on top. |
| `--json <file>` | Write the full report as JSON to the file. |
| `--list` | Print each case name and its tags. Run nothing. |
| `--help` | Print the usage line. |

The exit code is 0 when no result is `fail` or `error`, 1 otherwise, and 2 for bad input.

When the package is installed, the CLI is also available as `npx kv-conformance`.

## The adapter interface

An adapter is a module that exports `async function createAdapter(options)`. `options` is `{ clock }`, a virtual clock
that the runner makes. `createAdapter` returns this object:

```js
{
  name: 'reference',                 // free text, in the report
  defaultTimeoutMs: 300000,          // optional: the case timeout when the run sets none (default 30 s)
  kvStore,                           // the edge kvStore object: what an edge function sees as `kvStore`
  shapes: ['global', 'handle'],      // call shapes the adapter supports
  clock,                             // the clock in use: options.clock, or the adapter's own real clock
  capabilities: { ... },             // see the table below
  admin: {                           // outside the edge surface
    createStore({ format: 2 }) -> { storeId, identity: { org, store } },  // fresh, empty, allowed for kvStore
    declareIndex(storeId, def, { wait = true }) -> { name, state },      // wait: resolve when ACTIVE
    dropIndex(storeId, name),
    declareLedger(storeId, def, { wait = true }) -> { name, state, definition, definitionHash, activeAfter? },
    dropLedger(storeId, name),
    proofPublicKey(storeId) -> PEM string,     // only with capabilities.signedProofs
    dispose(),                                 // release everything the adapter made
  },
  control: {                         // optional hooks; present only when the matching capability is true
    setClock(ms),                    // server time for the entry id and `at`
    advanceArchive(storeId),         // archive every unarchived entry now (pending -> archived)
    injectFault({ op, when }),       // the next call of `op` fails: 'before' (nothing written) or
                                     // 'after-write' (written, then UNAVAILABLE: the outcome is unknown)
  },
}
```

The two shapes are the two ways an edge function calls the store:

- `global`: `kvStore.get(storeId, key)`.
- `handle`: `kvStore.open(storeId).get(key)`.

A case runs once for each shape that the adapter supports.

### Capabilities

A flag that is `false` or missing means "not supported". A case that needs the flag is skipped, with the reason in
the report. A skipped case is never counted as passed.

| Flag | Meaning when true |
|---|---|
| `virtualClock` | `clock.advance(ms)` is instant. It drives TTL expiry, the idempotency replay window, index build states, ledger activation and archives. |
| `eventualIndexLists` | A list by index can miss a write made just before it (the runtime). Cases then poll with `clock.advance`. |
| `indexBuildStates` | `declareIndex(..., { wait: false })` leaves the index `BUILDING`, and a query throws `INDEX_NOT_READY`. |
| `proofTiming` | `ledgerProof` moves from `pending` to `archived` when the archive runs (by `advanceArchive` or by time). |
| `signedProofs` | An archived proof has `digest`, `signature` and an audit path. `admin.proofPublicKey` gives the key to check them. |
| `search` | `search()` is implemented. |
| `secretEncryption` | `set(..., { secret: true })` stores an encrypted value (`encrypted: true`, `[ENCRYPTED]` in lists). |
| `subjectV1` | Ledger subject pseudonym mode, version 1. |
| `shortPages` | The scan budget of a page is at most `limits.shortPagesBudgetMax` (10) rows, so a page can be empty with `hasMore: true`. |
| `setClock`, `advanceArchive`, `injectFault` | The matching `control` hook exists. |

### Admin and control

`admin` does the work that an edge function cannot do: it makes stores, indexes and ledgers. `createStore` must
return a fresh, empty, format 2 store that the `kvStore` may use. `identity` is the `{ org, store }` pair that the
platform puts in ledger instance names. The ledger cases use it to recompute the genesis `prevHash`.

`declareLedger` takes `{ name, collection, chains, retentionDays, lockMode?, personalFields?, subjectField?,
subjectMode?, subjectCase?, anchor? }`. The adapter completes the definition (`v: 1`, defaults, `createdAt`). It
returns the full definition and its `definitionHash` (SHA-256 of the JCS bytes).

`dispose` runs once at the end of the run. It releases everything the adapter made.

`control` is optional. Each hook exists only when its capability flag is true. Without the hooks, the cases that need
them are skipped.

## Cases

Cases are data. `cases/index.mjs` exports `cases`, an array of objects:

```js
{
  name: 'core/kv/json-round-trip',   // unique, '/'-separated, stable (reports and filters use it)
  tags: ['core'],                    // one group tag, plus optional 'message-exact'
  needs: ['secretEncryption'],       // capability flags; any false -> skipped
  shapes: ['global', 'handle'],      // optional; default both
  adapter: true,                     // false for pure byte-layout cases (no adapter, run once)
  declares: ['ledger'],              // optional: 'ledger' and 'index' declarations the case waits for
  timeoutMs: 30000,                  // optional; overrides the timeout the runner computes; a timeout is a fail
  async run(ctx) { ... },            // throws an AssertionError (node:assert) to fail
}
```

`run(ctx)` gets a fresh store for each case and shape. The context has:

- `ctx.kvStore`: the adapter's `kvStore`.
- `ctx.kv`: a store view for the current shape. For `handle`, it is `kvStore.open(storeId)`. For `global`, its
  methods call `kvStore.<method>(storeId, ...args)`.
- `ctx.storeId`, `ctx.identity`, `ctx.admin`, `ctx.control`, `ctx.clock`, `ctx.caps`, `ctx.shape`.
- `ctx.limits`: the limits (see [Limits and the error contract](#limits-and-the-error-contract)).
- `ctx.expectKVError(promiseOrFn, expected)`: requires a `KVError` with the expected code and contract fields.
- `ctx.ledgerBytes`: the byte-layout functions (`lib/ledger-bytes.mjs`).
- `ctx.vectors`: the golden vectors (`vectors/ledger-vectors.json`).
- `ctx.uniqueKey(prefix)`: a key that is unique in the run.

To add a case, add it to a module in `cases/` and list the module in `cases/index.mjs`. Obey these rules:

- Never assert message text. Only a case tagged `message-exact` checks messages, and it checks nothing else.
- Do not depend on exact ids, versions, cursors or shard choices.
- Do not rely on the data of another case. Each case gets a fresh store.
- Read limit numbers from `ctx.limits`. Do not write a limit number in a case.
- Use `ctx.expectKVError` for errors.

A host can also iterate `cases` itself and call `run(ctx)` with its own context.

## Use it from node:test or mocha

`run()` takes the adapter (a module object or a path) and returns the report. It does not throw for a failed case.

```js
import { run, cases } from '@quantcdn/kv-ledger-conformance';
```

`run({ adapter, tags, enable, include, exclude, shapes, timeoutMs, onResult })`:

- `adapter`: the module (an object with `createAdapter`) or a path. To pass options to `createAdapter`, give an
  object with `createAdapter` and `options`, for example `{ ...reference, options: { budgetRows: 3 } }`.
- `tags`, `enable`, `include`, `exclude`: as for the CLI, as arrays.
- `shapes`: limit the run to some shapes.
- `timeoutMs`: the base timeout of a case (CLI `--timeout-ms`).
- `onResult(result)`: called after each result.

The runner calls `createAdapter` once for each run, and `admin.dispose()` at the end.

### node:test

This sample runs the suite once and makes one test for each case:

```js
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { run, cases } from '@quantcdn/kv-ledger-conformance';
import * as adapter from './my-adapter.mjs';

let report;
before(async () => {
  report = await run({ adapter, tags: ['bytes', 'core', 'ledger'] });
});

for (const c of cases) {
  test(c.name, (t) => {
    const results = report.results.filter((r) => r.name === c.name);
    if (results.every((r) => r.status === 'skip')) return t.skip(results[0]?.reason);
    const bad = results.filter((r) => r.status === 'fail' || r.status === 'error');
    assert.deepEqual(bad, []);
  });
}
```

### mocha

```js
import assert from 'node:assert/strict';
import { run, cases } from '@quantcdn/kv-ledger-conformance';
import * as adapter from './my-adapter.mjs';

describe('kv conformance', function () {
  this.timeout(600000);
  let report;
  before(async () => {
    report = await run({ adapter });
  });

  for (const c of cases) {
    it(c.name, function () {
      const results = report.results.filter((r) => r.name === c.name);
      if (results.every((r) => r.status === 'skip')) this.skip();
      const bad = results.filter((r) => r.status === 'fail' || r.status === 'error');
      assert.deepEqual(bad, []);
    });
  }
});
```

## The reference adapter

`adapters/reference/` is an in-memory implementation of the edge `kvStore`. It is for an emulator and for the tests
of the suite. **It is not for production.** It has no durability guarantee, no access control except the store
allow-list, and local keys only.

```js
import * as reference from '@quantcdn/kv-ledger-conformance/adapters/reference';
const adapter = await reference.createAdapter({ clock });
```

It has two layers:

- **The edge layer** (`lib/edge-surface.mjs`, `lib/edge-checks.mjs`, `lib/edge-calls.mjs`). It checks the arguments
  and options, does iteration, `open` and `verifyChain`, and has the `KVError` class. It calls the backend and
  nothing else.
- **The local backend** (`adapters/reference/backend/`). It has store-id-first methods that take checked arguments
  and return plain data, or throw a `KVError` with the store-level status. It holds stores, versions, TTL,
  indexes, transactions with idempotency, list pages and budgets, ledgers with the hash chain, a simulated archive
  with signed digests and proofs, sealed personal fields, secret values and fault injection.

The backend never imports the edge layer. An emulator can use the backend alone behind its own edge layer.

An emulator gets the backend from the reference adapter export, and the edge layer parts from the main export. It can
replace any part with its own. This example builds a `kvStore` over the backend, with the suite's edge layer:

```js
import { createLocalBackend } from '@quantcdn/kv-ledger-conformance/adapters/reference';
import {
  buildKvStore, createEdgeCalls, createEdgeChecks, createKVErrorClass, createRealClock,
} from '@quantcdn/kv-ledger-conformance';

const KVError = createKVErrorClass();
const backend = createLocalBackend({ clock: createRealClock(), KVError, org: 'my-org' });
backend.createStore({ id: 'site-data', format: 2 });
const calls = createEdgeCalls({
  backend,
  checks: createEdgeChecks(KVError),
  KVError,
  isAllowed: (storeId) => storeId === 'site-data', // the stores that the function may use
});
const kvStore = buildKvStore(calls, KVError); // give this to the edge function as `kvStore`
```

`createAdapter` options:

| Option | Meaning |
|---|---|
| `clock` | The clock. A virtual clock when absent. The runner gives one. |
| `seed` | The seed of the ledger shard choice (default 1). |
| `budgetRows` | Test-only scan budget for each page (default 10,000). At most `limits.shortPagesBudgetMax` (10), `capabilities.shortPages` is true and the `core/iteration/short-pages` case runs. Use `budgetRows: 3`, for example. |
| `storage` | A persistence hook `{ load(): snapshot \| null, save(snapshot), transaction?, changed? }`. The backend calls `load` when it starts and `save` after each write. A snapshot is a JSON-safe copy of every store, index, ledger, idempotency record, archive and the clock offset. See "Storage hook" below for `transaction` and `changed`. |
| `keys` | `{ secret, cursor, proof }`: local keys. The adapter makes new keys when absent. |
| `warn` | Called with a message for each unknown `set` or `delete` option. |
| `indexes` | Index settings: `{ initialState, activationMs, listLagMs }`. See "Index settings" below. |

The adapter also returns `backend`. `backend.snapshot()` and `backend.restore(snapshot)` save and load the full state.

### Storage hook

The backend does no I/O. The storage hook does the I/O. It has four functions:

| Function | Meaning |
|---|---|
| `load()` | Sync. Returns the snapshot, or `null`. The backend calls it at start, after `changed()` returns `true`, and after a failed save. `null` keeps the state in memory, and the next save writes it back. |
| `save(snapshot)` | Sync. The backend calls it after each write, also after a write that throws. Required when `transaction` is absent. Not used when `transaction` is present. |
| `transaction(run)` | Optional, async. Each write calls `transaction(async (fresh) => next)`. The hook takes its lock, loads the fresh snapshot (or `null`), calls `run(fresh)`, saves the snapshot that `run` returns, and then releases the lock. |
| `changed()` | Optional, sync. Each read calls it, and without `transaction` each write too. When it returns `true`, the backend reloads with `load()`. An mtime check is an example. While a write of this process is in flight, reads do not reload. |

Use `transaction` when two processes share one snapshot, for example two `quant serve` processes on one file. Without
it, two processes that write at the same time can overwrite each other's writes, also with `changed()`. The lock
covers the full snapshot.

When a save fails (`save` or `transaction` throws after the write ran), the backend puts its memory back to the disk
state and the write throws the error.

> **Caution:** With `transaction`, every write method of the backend returns a promise, and the admin calls do too
> (`createStore`, `declareIndex`, `dropIndex`, `setIndexState`, `declareLedger`, `setClock`, `reset`).
> `ledgerStatus` and `ledgerProof` are writes too, because they can run the archive. Writes of one backend run in
> the order of the calls. The edge layer and the adapter already await them. The other reads stay synchronous.

> **Caution:** Do not call a backend write from inside `transaction`. The write waits for its own lock, and it
> never ends. `injectFault` applies to the next call of the operation in the queue, which can be a write that was
> called before `injectFault`.

An example on a file, for Node:

```js
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

function fileStorage(file) {
  let seen = 0;
  const load = () => {
    try {
      const text = readFileSync(file, 'utf8');
      seen = statSync(file).mtimeMs;
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  return {
    load,
    changed: () => { try { return statSync(file).mtimeMs !== seen; } catch { return false; } },
    async transaction(run) {
      const lock = openSync(`${file}.lock`, 'wx'); // fails when another process holds the lock: retry it
      try {
        const next = await run(load());
        writeFileSync(`${file}.tmp`, JSON.stringify(next));
        renameSync(`${file}.tmp`, file);
        seen = statSync(file).mtimeMs;
      } finally {
        closeSync(lock);
        unlinkSync(`${file}.lock`);
      }
    },
  };
}
```

### Index settings

| Setting | Default | Meaning |
|---|---|---|
| `initialState` | `'BUILDING'` | `'ACTIVE'` makes a new index ACTIVE at once, with no timer. The backfill check still runs, so an index can be `FAILED`. Use `'ACTIVE'` for local development. |
| `activationMs` | 75000 | The time an index stays `BUILDING` after its declaration. Only with `initialState: 'BUILDING'`. |
| `listLagMs` | 0 | A list by index leaves out an item until `listLagMs` after its last write, as the runtime can. `getBy` and `count` have no lag. |

`listLagMs` is an approximation. A rewritten item leaves the list for `listLagMs` (the runtime can show the old
version). A delete has no lag.

`capabilities.eventualIndexLists` is `true` when `listLagMs` is more than 0. `capabilities.indexBuildStates` is
`false` with `initialState: 'ACTIVE'`.

`control.setIndexState(storeId, name, state)` (and `backend.setIndexState`) holds an index in a state until the next
call: `'ACTIVE'` (with no backfill check), `'BUILDING'` or `'FAILED'`. Use it to test how a function handles
`INDEX_NOT_READY`. It is a hook of the reference adapter only, not part of the adapter contract.

The reference adapter passes every `bytes`, `core`, `ledger` and `proof-timing` case only with a small scan budget
(`budgetRows` at most 10, for example 3). With the default budget, `core/iteration/short-pages` is skipped. It has
`subjectV1: false` until the subject contract is stable.

## Run against the real edge runtime (edge harness)

> **Note:** The edge harness adapter and the public API adapter are not yet validated against a live platform.
> `VALIDATED_AGAINST` in `lib/version.mjs` is empty. Until it has an entry, treat a failure as a possible adapter
> fault, and read the known gaps of each adapter below.

The edge harness runs the cases on the real edge runtime. The owner of a Quant project runs it. It has two parts:

- `adapters/edge-harness/harness-fn.js`: an edge function body. It receives a list of `kvStore` calls, runs them on
  the runtime's `kvStore`, and answers the results as JSON.
- `adapters/edge-harness/index.mjs`: the adapter. Its `kvStore` sends each call to the function and rebuilds the
  result or the `KVError`. The admin (stores, indexes, ledgers, the proof public key) goes through the public API
  adapter.

> **Warning:** Never commit a token or an API key. Keep them in environment variables only. The suite never logs
> them and never writes them to a report.

> **Caution:** A store with a ledger cannot be deleted until the ledger retention ends. The run keeps these stores.
> Use a throwaway project.

A run keeps every store that it makes until `dispose` at the end of the run. That is about one store for each case
and shape.

Steps:

1. Make a throwaway project. Do not link any other stores to it.
2. Make a random token of 32 characters or more, for example with `openssl rand -hex 32`.
3. Copy `harness-fn.js`. Replace the placeholder `__HARNESS_TOKEN__` with the token. If the placeholder stays, or the
   token is shorter than 32 characters, the function answers 503 to every request.
4. Deploy the copy as an edge function in the throwaway project. Route one path to it.
5. Set the environment variables:

   | Variable | Value |
   |---|---|
   | `KVC_HARNESS_URL` | The full URL of the path that runs the function. |
   | `KVC_HARNESS_TOKEN` | The token from step 2. |
   | `KVC_API_BASE` | The API origin (http or https). |
   | `KVC_ORG` | The organisation. |
   | `KVC_PROJECT` | The throwaway project. The stores of the run belong to it, so the function may use them. |
   | `KVC_API_TOKEN` | An API token with KV access to the project. |
   | `KVC_RATE` | Optional. Admin requests per second (default 3). |

6. Run the core and ledger cases:

   ```sh
   node run.mjs --adapter adapters/edge-harness/index.mjs --tags core,ledger --json edge-core.json
   ```

7. Run the proof timing cases. Each case can take up to 20 minutes, because it waits for the real archive:

   ```sh
   node run.mjs --adapter adapters/edge-harness/index.mjs --tags proof-timing --json edge-proof.json
   ```

8. Read the dispose line on standard error. It names the stores that the run could not delete. To delete such a
   store, wait until the ledger retention ends, every ledger of the store is `DROPPED` and the archive is finished.
   Then delete the store.

The harness clock is real, and it has no control hooks. These cases are skipped with the reason in the report:

- Need `virtualClock`: `core/ttl/expired-reads`, `core/ttl/ifAbsent-on-expired`, `core/ttl/ifVersion-on-expired`,
  `core/ttl/rewrite-clears-ttl`, `core/list/cursor-expired`, `core/indexes/not-ready`, `ledger/replay-window`,
  `ledger/window`.
- Need `injectFault`: `core/increment/lost-response`, `core/atomic/lost-response-with-key`,
  `core/atomic/lost-response-without-key`, `ledger/lost-append-with-key`, `ledger/lost-append-without-key`.
- Need `shortPages`: `core/iteration/short-pages`.
- The `subject-v1` group. It runs only with both `--tags subject-v1` and `--enable subject-v1`.

Known gaps of the edge harness adapter:

1. JSON has no `undefined`. An `undefined` argument travels as `null` with a list of its positions, and the function
   restores it. An `undefined` inside an array in a value becomes `null`.
2. The result of `list` and `search` is a lazy thenable. `await` sends one page call when it is awaited, not when
   the query is made.
3. `await query` and then `query.items()` (or `pages()`, or `for await`) on the same query send two requests.
4. `verifyChain` is synchronous in the type definitions, so it runs in the adapter (locally), not in the function.

The function refuses a request without a correct token (403). It refuses a request that is not `POST` (405), a body
over 1 MiB (413) and a bad call (400). It makes no `kvStore` call for a refused request.

## The public API adapter

`adapters/http/` runs the cases over the public KV v2 HTTP API. A third party can use it to run the suite from its own
application. The `kvStore` of this adapter uses the same edge layer and argument checks as the reference adapter.

Environment variables:

| Variable | Value |
|---|---|
| `KVC_API_BASE` | The API origin (http or https). The adapter adds `/api/v2/organizations/{org}/projects/{project}/kv`. |
| `KVC_ORG` | The organisation. |
| `KVC_PROJECT` | The project. |
| `KVC_API_TOKEN` | The API token. It is sent only as a bearer token. It is never logged. Server text that holds it is redacted. |
| `KVC_RATE` | Requests per second, default 3. |
| `KVC_DISPOSE_MS` | The time `dispose` may spend on store deletes, default 300000 (5 minutes). |

```sh
node run.mjs --adapter adapters/http/index.mjs --tags core,ledger
```

The rate cap is a token bucket. Every request goes through it, admin requests too. The bucket holds
`Math.max(rate, 1)` tokens. A rate below 1 (for example 0.5) gives one request every `1 / rate` seconds and no burst.

Admin requests that answer 429 or 503 with `retryable: true` are sent again after `Retry-After`. The adapter caps
`Retry-After` at 60 s and sends a request at most 8 times. An admin wait never goes past the deadline of its poll.
Data calls (the `kvStore` methods) are never sent again.

`dispose` deletes the stores that the adapter made. A store with a ledger cannot be deleted. The adapter names it in
the dispose summary and on standard error. A store delete is a kv-admin operation, which the platform limits to about
10 a minute for each project, so a full run can make more stores than `dispose` can delete in time. After
`KVC_DISPOSE_MS`, `dispose` stops and names each store it did not reach with the code `DISPOSE_DEADLINE`. Run the
suite in a project made for the run, and delete the project afterwards.

This adapter is not yet validated against a live platform (see the note in the edge harness section). The shape
mappings were tested only against a small fake server. The mappings of `transact`, `append`, `getMany`,
`increment`, `count`, `getBy` and `search` were not run against a live API.

Gaps. The public API cannot express all edge behaviour:

1. Secret values are write-only through the API. A single-key read gives `[ENCRYPTED]`. Thus `secretEncryption` is
   false, and the `core/secret` cases and `core/indexes/secret-in-indexed` are skipped.
2. `atomic().check(key, null)` ("the key must be absent"): the API check takes a version only. The adapter sends
   `version: null` and the server decides.
3. A raw read (`get(storeId, key, true)`) is the parsed JSON serialised again. It is not always the same bytes.
4. `ledgerStatus` reads only the first page of instances (50). `hasMoreShards` tells the caller. The sums cover that
   page only.
5. Pages have no `scannedCount`.
6. Ledger entries read through the API show personal fields as `[PERSONAL]`. The API can reveal sealed fields only
   with a dedicated permission, and every reveal is logged. The adapter does not reveal. The edge reads the fields
   open, so cases that read personal fields back can differ.
7. `FORBIDDEN` for a store that the adapter did not make is a client-side check. The API itself answers 404
   `STORE_NOT_FOUND` for a store outside the project.
8. A key that is exactly `.` or `..` can be changed by URL path rules. The adapter does not handle it.
9. The automatic idempotency key of an append goes to the API as an explicit `idempotencyKey`.
10. There is no fault injection, archive control or clock control. The `proof-timing` cases use real time.

`identity.store` is the store id that the create returns (for example `myorg-myproject-mystore`). The platform names a
ledger instance `{org}/{store id}/{collection}#{shard}`, so the genesis checks of the ledger cases use the store id, not
the name that the adapter sends at create. `dispose` also names stores by their id.

## Tags and groups

Each case has one group tag. The counts are for this version. "Results" counts each shape as one result, on the
reference adapter.

| Tag | Default | Cases | Results (reference) | Content |
|---|---|---|---|---|
| `bytes` | on | 9 | 9 pass | Byte-layout vectors, no adapter: JCS definition hash, genesis hash, entry hash, Merkle root and audit paths, digest genesis, source chain. |
| `core` | on | 116 | 228 pass, 1 skip | get/set/delete, getEntry/getMany, conditional writes, TTL, increment, atomic, list/search, collections, cursors, iteration, the handle, `KVError`, the error contract, limits, indexes, secrets, `verifyChain`. |
| `ledger` | on | 26 | 52 pass | append, receipts, idempotency replay, chains, list windows, status, `verifyChain` over a ledger list, immutability, ledger errors, proof `pending`. |
| `proof-timing` | off (slow) | 3 | 6 pass | proof `pending` to `archived`, signed proof checks, status after the archive. |
| `subject-v1` | off, needs `--enable subject-v1` | 6 | skip (`subjectV1` false) | Subject pseudonym mode, version 1 of the subject contract. |
| `message-exact` | off | 0 | none | Exact message text. A case with this tag checks only messages. |

The one `core` skip is `core/iteration/short-pages`. It passes with `budgetRows: 3`. The `subject-v1` group runs
only with both `--tags subject-v1` and `--enable subject-v1`.

## The report

`run()` returns the report. `--json <file>` writes it.

```json
{ "suite": "kv-conformance", "version": "0.1.0", "apiSurface": "edge kvStore d.ts of ...", "validatedAgainst": [],
  "adapter": "reference", "capabilities": { "...": true }, "shapes": ["global", "handle"],
  "tags": ["bytes", "core", "ledger"], "startedAt": "...", "durationMs": 1234,
  "summary": { "total": 295, "pass": 285, "fail": 0, "skip": 10, "error": 0 },
  "results": [ { "name": "...", "tags": ["core"], "shape": "handle", "status": "pass", "ms": 3, "reason": "..." } ] }
```

Each result has one status:

- `pass`.
- `fail`: an assertion failed, the case threw, or the case timed out.
- `skip`: with the reason (a missing capability or shape, or a tag that is not selected or not enabled).
- `error`: the setup failed or timed out outside the case (for example `createStore` threw).

`apiSurface` names the revision of the edge kvStore contract that the suite tests.

## Limits and the error contract

`lib/limits.mjs` exports `LIMITS`, one frozen object with every limit that the cases use. Each value names its
source. Cases read numbers only from it.

`lib/error-contract.mjs` exports `ERROR_CODES`: one row for each `KVErrorCode` of the edge types, with `status`,
`retryable` and the detail fields. `DETAIL_FIELDS` lists the detail fields of `KVError`.

`ctx.expectKVError` checks that the error is an instance of `kvStore.KVError` with `name` `KVError`, the expected
`code`, the contract `retryable` and `status`, the expected detail fields, and only scalar detail values. It never
checks the message.

Both are exported from the package: `import { LIMITS, ERROR_CODES } from '@quantcdn/kv-ledger-conformance'`.

## Known drift between sources

The contract sources are, in order of authority: the edge `kvStore` type definitions, the "Edge function KV store
API" page, the KV stores and KV ledgers docs pages, and the golden vectors. Where they disagree, the suite follows the
type definitions. These are the known differences:

- The collection list `limit` is 1 to 100 on the stores and ledgers pages, and 1 to 1000 in the type definitions and
  the platform. The suite uses 1 to 1000.
- The format 2 read budget on the stores page (2,000 rows, 20 requests, 4 s) differs from the scan cap in the type
  definitions (10,000 rows). The suite tests only the behaviour: a short page with `hasMore: true` continues.
- An append to a dropped ledger: the ledgers page says `LEDGER_IMMUTABLE`. The type definitions and the platform say
  `LEDGER_DROPPED` (409). The suite requires `LEDGER_DROPPED`.
- The type definitions show `atomic().check('k', null).set('k', 1)`, with one key twice. The platform refuses a key
  that occurs twice in a transaction (`VALIDATION`), as the stores page says. The suite follows the platform.
- The stores page says that an invalid list option rejects with a plain `Error`. The type definitions say that every
  error is a `KVError`. The suite requires `KVError` `VALIDATION`.
- To drop an `ACTIVE` ledger before its retention ends: the ledgers page says `LEDGER_RETAINED`. The platform drops an
  empty `ACTIVE` ledger at once, and an append after the drop is `LEDGER_DROPPED`. The suite requires
  `LEDGER_DROPPED` after the drop. This must be confirmed on a live platform.

## Deferred

- Rule, static and function vectors are not in this repository.
- Format 1 cases (null or false on failure, legacy scan lists). The local backend accepts format 1 stores already.
- The `subject-v1` cases run only after the subject contract is released and enabled.
- Store upgrade, export, shred and verification reports. They are management features, not the edge surface.

## Versioning

The suite version is `0.1.0` (`SUITE_VERSION` in `lib/version.mjs`). It stays 0.x until the KV v2 release ships to
production. After that, the major and minor numbers follow the KV API release that the suite covers.

`VALIDATED_AGAINST` in `lib/version.mjs` lists the runs against real builds: `{ target, build, date, result }`. It is
empty today. The report states both values.

See [CHANGELOG.md](CHANGELOG.md).

## The offline verifier

The verifier checks a downloaded ledger archive against a public key. It does not call Quant. The full guide is in
[verifier/README.md](verifier/README.md): the inputs, the checks, the reasons and the exit codes.

You can use the verifier alone. As a CLI:

```sh
npx kv-ledger-verify --dir ./archive --store acme/audit --public-key key.pem
npx kv-ledger-verify verify-proof proof.json --public-key key.pem
npx kv-ledger-verify verify-signed --doc report.json --public-key key.pem
# or, from a checkout:
node verifier/verify.mjs --dir ./archive --store acme/audit --public-key key.pem
```

As a library:

```js
import { verifyArchive, verifyProof, verifySigned, keysFromJson, purgeCheck } from '@quantcdn/kv-ledger-conformance/verifier';
```

The golden vectors are a package export too:

```js
import { createRequire } from 'node:module';
const vectors = createRequire(import.meta.url)('@quantcdn/kv-ledger-conformance/vectors/ledger-vectors.json');
```

## Contributing

- Use Node 20 or later. Add no dependencies: the standard library only.
- Run `npm test` before you send a change. It runs the tests of the suite and of the verifier.
- Keep functions small: a cyclomatic complexity of 10 or less. Use lookup tables, not long if/else chains.
- Start each new `.mjs` or `.js` file with `// SPDX-License-Identifier: Apache-2.0` (after a shebang line, if there
  is one), then `// Copyright 2026 QuantCDN Pty Ltd`.
- Cases never assert message text, except cases tagged `message-exact`.
- Write no internal host names, account ids, internal header names, internal route paths or internal names. The
  test `test/public-safety.test.mjs` scans every file. Its tracked deny-list holds generic patterns only: cloud
  provider hosts and resource names, ARNs, account-id shaped numbers in an ARN or account context, and local paths.
  Maintainers keep a private list of further patterns in an untracked file. To use it, set `KVC_SAFETY_DENYLIST` to
  the file path before `npm test`. The file holds one regular expression per line; blank lines and lines that start
  with `#` are skipped.
- Each case must be able to fail. `test/mutations.test.mjs` shows how to check this with a broken adapter.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
