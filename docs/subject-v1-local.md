# subject-v1 in the local backend

Date: 2026-10-29. This note says what the local backend (`adapters/reference/backend/`, published as
`@quantcdn/edge-kv`) emulates of the ledger subject contract, version 1, and what it does not. The source of truth
is the platform code. Where the ledgers page and the platform code disagree (for example, the ledgers page still
shows `subjectId` in a shred entry), the backend follows the platform code.

## 1. The model

A ledger with a `subjectField` names a data subject in each entry. The server canonicalises the subject id (a string
or a safe integer, trimmed, NFC, folded with `subjectCase: 'fold'`; see `fixtures/subject-v1-vectors.json`) and keys
it with a store key:

- `subjectRef` = HMAC-SHA256(store reference key, `"qkv-subject-ref-v2\n<ledger>\n<canonical id>"`), the first 32 hex
  characters. Shred entries, erasure records and receipts name the subject by this reference.
- Each subject has a key generation: a random token (`qsub1_` and 26 Crockford base32 characters), a 32-byte
  AES-256-GCM key and a generation id. A shred destroys the generation. An append 60 seconds or more after a shred
  makes the next generation.

The declare options are the platform's:

| Option | Values | Default | Rule |
|---|---|---|---|
| `subjectField` | a top-level field name | none | Required when `personalFields` is not empty (`LEDGER_SUBJECT_REQUIRED`). Not a personal field. |
| `subjectMode` | `'pseudonym'`, `'clear'` | `'pseudonym'` | Needs `subjectField`. In the hashed definition. Immutable. |
| `subjectCase` | `'exact'`, `'fold'` | `'exact'` | Needs `subjectField`. In the hashed definition. Immutable. |

Stored form:

- `pseudonym`: the subject field stores the token, and `$subject` stores the value as appended, sealed (AAD
  `<org>/<store>/<collection>/<id>/$subject`).
- `clear`: the subject field is stored as given, and `$subjectTag` stores the token.
- Personal fields are sealed with the subject key in both modes. `$subject` and `$subjectTag` are reserved in an
  appended value (`VALIDATION`).

Reads:

- `get`, `getEntry`, `getMany`, `getBy`, a ledger list and a list by index open the sealed fields. In `pseudonym`
  mode the subject field shows the value as appended and `$subject` is left out. After a shred, each sealed field of
  that generation (the subject field included) reads `{ $shredded: true }`.
- Scan, prefix and pattern lists do not open: the subject field shows the token, `$subject` is left out, and each
  sealed personal field reads `"[PERSONAL]"`.
- `ledger.subject` is `'pseudonym'` or `'clear'` when the ledger has a subject field.
- A list by index with `equals` on the subject field of a pseudonym ledger finds the subject's live token. A shredded,
  absent or malformed subject gives an empty page. A list with `where` on a subject field matches that ledger's
  entries by token.

## 2. What the local backend emulates

| Platform | Local backend |
|---|---|
| Declare: `subjectMode`, `subjectCase`, the defaults, the rules and their messages. | Same. |
| Canonical subject id and its `VALIDATION` messages. | Same (`subject-canonical.mjs`). |
| Store subject reference key, `subjectRef`, version 1. | Same formula. |
| Subject key generations: token, key, generation, the 60-second `CONTENTION` after a shred. | Same. |
| Stored form (`pseudonym`, `clear`), AAD, `$subject`, `$subjectTag`. | Same. |
| Decrypted and sealed reads, `{ $shredded: true }`, `ledger.subject`. | Same. |
| Index `equals` and `where` by the subject's live token. | Same. |
| Index rules against ledgers: plain indexes only (`LEDGER_INDEX_KIND`), no personal field (`INDEX_FIELD_ENCRYPTED`), no `sortBy` on a subject field (`VALIDATION`), a pseudonym subject index inside the ledger collection (`LEDGER_INDEX_KIND`). | Same, in both orders of declaration. |
| An idempotency key used before its subject was erased (`VALIDATION`, the platform message). | Same. |
| A ledger with a subject field and no `subjectMode` (the retired format): `LEDGER_FORMAT_RETIRED` on append and on a decrypted read. | Same. A snapshot from `@quantcdn/edge-kv` 0.1.x with such a ledger reads this way. |
| `POST …/ledgers/{name}/shred` `{ subjectId, reason, authority, requestedBy }`: shred entries `{ $event: 'shred', subjectRef, reason, authority, requestedBy }` from `platform` / `quant-ledger`, then the key is destroyed, the erasure record, and a signed receipt (`kv-ledger-shred-receipt`, v 2). A repeat answers `alreadyShredded: true` with the same receipt. | `backend.shred(storeId, ledger, body)`. The 200 answer body. |
| `POST …/ledgers/{name}/subject-entries` `{ subjectId, collection?, since?, until?, limit?, nextToken?, personal? }`. | `backend.subjectEntries(storeId, ledger, body)`. The 200 answer body. |

## 3. What it does not emulate

- **KMS.** The platform wraps the subject keys and the reference key with KMS. The local backend keeps them as plain
  base64 in its state, and so in `snapshot()`, like the secret, cursor and archive keys. Anyone who can read the
  snapshot can read every personal field, also a "shredded" one from an older snapshot. Do not put real personal data
  in it.
- **Backups.** `fullyErasedAfter` is `shreddedAt` plus 35 days, as on the platform, but the local backend has no
  point-in-time recovery: the key is gone from the current state at once.
- **Reference key rotation.** Only version 1. `refKeyVersion` is always 1. There are no moved ref rows.
- **Time budget.** The platform stops a shred after about 20 seconds and answers 202 `in_progress`. The local
  backend runs the whole shred in one write and always answers the 200 body. So it has no progress markers and no
  finishing of an earlier, partial shred.
- **Forked stores.** No `ledgerForked`, no `supersedes`.
- **Other routes.** No `subject-preview`, no shreds list, no receipt route and no shred entries route. The erasure
  records are in the snapshot (`shreds`), and the shred answer holds the receipt.
- **Signing key.** The receipt is signed with the local archive key (`keyId` `local-reference-key`,
  `backend.publicKey()`), not the platform ledger key. `verify.mjs verify-signed` accepts it with that key.
- **Permissions.** No `delete_content` permission check. The edge `kvStore` has no shred and no subject entries call;
  only the backend (an emulator's management side) has them.
- **Cursors.** The `subject-entries` `nextToken` is a local cursor (the format of the list cursors), not the platform
  format. An invalid one is `CURSOR_INVALID` with the local message.
- **Concurrency.** The platform orders a write that read the key before a shred and committed after it. The local
  backend runs one write at a time, so this case does not occur.

## 4. Where the calls are

| Call | Where |
|---|---|
| `declareLedger(storeId, { …, subjectField, subjectMode?, subjectCase?, personalFields? })` | backend; adapter `admin.declareLedger` |
| `append`, `get`, `getEntry`, `getMany`, `getBy`, `list`, `ledgerStatus`, `ledgerProof` | edge `kvStore` (no change in the edge layer) |
| `shred(storeId, ledger, { subjectId, reason, authority, requestedBy })` | backend (a write); adapter `admin.shred` |
| `subjectEntries(storeId, ledger, { subjectId, … })` | backend (a read); adapter `admin.subjectEntries` |

The state is in the snapshot: per store, `subjectRefKeys`, `subjectRefs`, `subjectTokens`, `subjectListings` and
`shreds`. A snapshot of an earlier version has none of them, and they start empty. `subjectKeys` holds the keys of the
retired format.
