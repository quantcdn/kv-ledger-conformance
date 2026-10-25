# kv-ledger-verify

Part of the KV ledger conformance package. See the [root README](../README.md) for the conformance suite, the golden vectors and how to use the verifier as a library.

Open-source offline verifier for Quant KV ledger archives. It uses only the Node.js standard library (Node 20 or later). No other package is needed.

The verifier does not call Quant. It reads a downloaded archive and checks it against a public key. If the archive is complete and unchanged, the verifier exits with code 0.

## Inputs

1. The archive files. Download every URL from `GET .../ledgers/{name}/archive` into one root directory. Keep the paths:
   - `ledgers/<org>/<store>/<ledger>/<collection base64url>/<shard>/<period>-<from 12>-<to 12>.jsonl.gz`
   - `digests/<org>/<store>/<period>.json` and `<period>.json.sig`
   - `digests/<org>/<store>/anchors/<YYYYMMDD>.tsr` (optional)
2. The public key. Save the PEM from `GET .../ledgers/public-key` to a file.
3. Receipts (optional). A JSONL file. Each line has `key`, `seq`, `hash` and `prevHash`, as the append calls returned them.

## Usage

```bash
node verify.mjs --dir ./archive --store acme/audit --public-key ./key.pem [--receipts ./receipts.jsonl] [--anchors ./archive/digests/acme/audit/anchors] [--as-of 2026-10-16T03:30:00Z] [--strict] [--list-entries] [--json]
```

| Exit code | Meaning |
| --- | --- |
| 0 | Everything verified, nothing pending. |
| 1 | A check failed (with `--strict`, also when objects are pending). |
| 2 | The input is bad (missing option, unreadable file, `--as-of` not an ISO time). |
| 3 | Incomplete: no check failed, but objects are pending (digest not written yet). Pending is not a pass. |

For a final audit, use `--strict`. A pending object needs a period that has started (not after `--as-of`) and that is not earlier than the object before it in the shard. Otherwise it is `archive_mismatch`.

An object written in the last hour may have no digest yet. The verifier lists it as pending, not as a failure, until 1 hour after its 5-minute period ends. Use `--strict` to treat pending objects as failures, and `--as-of <ISO time>` to verify as of a past time (default: now). The grace is `DIGEST_GRACE_MS` (3,600,000), the same number as the server verify.

As a library: `import { verifyArchive } from './lib/verify.mjs'` and call `verifyArchive({ dir, publicKeyPem, store, receipts?, anchorsDir?, asOf?, strict? })`. The verifier checks ONE store, named `<org>/<store>`. Run it once for each store. The result is `{ ok, store, entries, reason?, shards: [{ ledger, collection, shard, fromSeq, toSeq, ok, firstBrokenSeq?, reason?, objectFromSeq?, objectToSeq? }], pending: [{ collection, shard, fromSeq, toSeq }], sources: [{ source, entries }], entryList?, receipts?, anchors? }`. `sources` counts the entries per writer (`source` is `{ type, principal }`, or `null` for an entry written before Quant recorded a source). Only entries whose hash verifies are counted. With `listEntries: true` (CLI `--list-entries`), `entryList` has one `{ collection, shard, seq, key, hash, source }` per such entry. If the store has no `ledgers/<org>/<store>` directory, `ok` is false and `reason` is `archive_missing`.

## Reasons

| Reason | Meaning |
|---|---|
| `missing_entry` | A sequence number is missing, or a digest lists an archive object that is not in the archive. |
| `hash_mismatch` | The recomputed hash of an entry, or its link to the previous entry, differs from the stored value. |
| `digest_mismatch` | The Merkle root or the head hash of an archive object differs from the signed digest, or no digest covers the object. When the head hash differs, `firstBrokenSeq` is the last sequence number of the object. |
| `bad_signature` | The digest signature is wrong, the digest chain is broken, or a definition hash is wrong. |

`firstBrokenSeq` is the lowest sequence number with a failure in the shard.

For `digest_mismatch` the shard result also has `objectFromSeq` and `objectToSeq`. The whole object range is untrusted. The verifier cannot say which entry inside the range changed, because the digest holds only the Merkle root and the head hash. `firstBrokenSeq` is then the head of the object (head hash differs) or the first entry (root differs).

An entry's writer (`source`, for example `{"type":"edge","principal":"gov-ai/<function id>"}`) is part of its stored `value` string, so the entry hash covers it. A changed, added or removed `source` is `hash_mismatch` at that entry. Entries written before Quant recorded a source have none and verify the same way.

An object that cannot be decompressed is `missing_entry` at the `fromSeq` in its file name. A line that is not a JSON object is `hash_mismatch` at the same `fromSeq`. These are verification failures (exit code 1), not bad input.

## What the verifier checks

- Each entry hash, with the genesis hash built from the instance name and the definition hash in the digest.
- The sequence continuity and the `prevHash` links across all objects of a shard.
- For each object, the RFC 6962 Merkle root and the head hash against the digest.
- The ECDSA P-256 signature of each digest, the digest chain, and the definition hashes.
- Receipts against the archived lines.
- Timestamp tokens: the SHA-256 imprint in the token must equal the `digestHash` of its binding (legacy: the hash of the last digest of the UTC day).

The test vectors are in `vectors/ledger-vectors.json` in this repository. This file is the source. The vectors are also published on the Quant docs site at `/kv/ledger-vectors.json`. Run `npm test` to check this implementation against them.

## Limits

- An empty but present store archive (no objects, no digests) verifies with 0 entries. Deletion detection needs receipts or anchors.
- Without receipts or anchors, an offline check cannot detect the deletion of the newest digests together with their objects. The archive then looks complete up to an earlier period. Keep receipts, or use `--anchors`.
- With `--anchors`, the verifier reads every anchor file for the named store: from `<dir>/<org>/<store>/` if it exists, else from `<dir>` itself (flat). The result field `anchorMode` is `bindings` or `legacy`.
- Binding mode (any `<YYYYMMDD>.anchor.json` present). An anchor binds one exact digest: `{ "v": 1, "types": ["rfc3161"], "digestKey": "digests/<org>/<store>/<name>.json", "digestHash": "<sha256 hex>", "anchoredAt": "..." }`. The bound digest is usually from the day after the anchored day. For each binding the verifier checks that the digest is in the chain and trusted, that its SHA-256 equals `digestHash`, and that `<YYYYMMDD>.tsr` has an imprint equal to `digestHash`. These cases fail and are listed in `anchors.mismatched` with a reason in `anchors.details`: a malformed binding (`bad_binding`), a digest that is not in the chain (`digest_not_in_chain`), a wrong hash (`digest_hash_differs`), an untrusted digest (`digest_not_trusted`), a binding with no token (`binding_without_token`), a token with no binding (`token_without_binding`), and a wrong imprint (`token_imprint_differs`). The result lists `anchors.bindings` (count) and `anchors.boundDigests`.
- Coverage. A digest is covered when a valid anchor binds that digest or a later one, because each digest contains the hash of the previous digest. Digests after the latest bound digest (for example a supplementary digest written after the anchor) are listed in `anchors.unanchoredDays` and make `ok` false until the next anchor.
- Legacy mode (no binding files). A token covers the last digest of its UTC day. A token whose day has no digest is a failure. A digest day with no token is listed in `anchors.unanchoredDays` and makes `ok` false.
- Customer-bucket anchors. The binding lists its anchor types in `types` (sorted, unique, non-empty, from `customer-bucket` and `rfc3161`). A binding without a valid `types` list is a failure (`bad_binding`). For each listed type the verifier requires its evidence: `rfc3161` needs the `.tsr` (`binding_without_token` if absent); `customer-bucket` needs the customer copy. A binding without any evidence does not cover its digests. Only for a legacy binding file without `types`, the verifier infers the type: a `.tsr` beside it means `rfc3161`, otherwise `customer-bucket`. The copy in the customer bucket is the proof. Download the customer prefix (`<prefix><org>/<store>/`) and pass it with `--anchor-copies <dir>` (library input `anchorCopiesDir`; either that prefix or a directory with `<org>/<store>/` inside). The verifier then requires: every copied digest, `.sig` and `anchors/<day>.anchor.json` is byte-identical to the archive; a copied file that the archive lacks is a failure (`copy_not_in_archive`, it shows a deleted digest); each binding has a copy (`binding_copy_missing`, `binding_copy_differs`); and the digests from the earliest copy up to the bound digest are all present with their `.sig` (`copy_missing_digest`). Without `--anchor-copies`, these bindings are listed in `anchors.unwitnessed` (`day`, `type`, reason `customer_copy_not_provided`). A binding file alone is not external evidence, because it is written to the Quant bucket before the external step. An unwitnessed binding does not cover any digest, so its digests appear in `anchors.unanchoredDays` and `ok` is false. An auditor must obtain the customer copy and run the check again with `--anchor-copies`. A day whose timestamp request failed all day also leaves a binding with no token, and is reported the same way.
- Timestamp token check. Every `.tsr` must be a real RFC 3161 response and is verified with the Node standard library: the CMS signature of the signed attributes, the messageDigest of the TSTInfo, the signer (matched by issuer Name and serial) with a critical extendedKeyUsage that holds only `id-kp-timeStamping` and the subject `O=DigiCert, Inc.`, any intermediate EKU that includes `id-kp-timeStamping`, and the chain to the pinned DigiCert Trusted Root G4 (SHA-256 `55:2F:7B:DC:...:99:88`). Certificate validity is checked at the genTime of the token, so an old archive still verifies after the certificates expire. A token that does not pass the full check is a failure (`bad_token_signature`), also when it carries the right imprint bytes. The result field `anchorTokenCheck` is `signature` when a token was checked. Not checked: the ESS signingCertificate attribute and revocation (no CRL or OCSP fetch). For tests only, `--tsa-root <pem>` (library `tsaRootsPem`) replaces the pinned root.
- `archive_mismatch` offline means one of two things. A fork (ruling F10): an archive object, in key order, whose seqs overlap the objects listed before it in the same shard. It is reported at the first shared seq, with `objectFromSeq` and `objectToSeq` of the later object, and that object gets no line or digest check. A name that the archive job never writes, under `ledgers/<org>/<store>/<ledger>/`: inside a shard folder, that shard fails at seq 1; elsewhere it is a failed result of its own (shard `''` for a folder that is not the exact base64url of a collection, else the bad shard folder or key name). The server verify reports both the same way. The other server `archive_mismatch` cases (an archived line that differs from the live entry, index rows that disagree with the bucket) need the live table, so they do not occur offline.
- The public key must be an EC P-256 key (the `publicKeyPem` field from the public-key route). Another key type makes every digest `bad_signature`. The `.sig` file must have `v: 1` and `algorithm: "ECDSA_SHA_256"`.

## Signed reports and receipts (verify-signed)

A verification report (`GET .../ledgers/{name}/verifications/{verificationId}/report`) is a signed document: `{ report, json, signature, keyId, algorithm }`. A shred receipt is one too: the `receipt` object of a shred answer is `{ json, signature, keyId, algorithm }`, and `GET .../ledgers/{name}/shreds/{shredId}/receipt` answers `{ receipt, json, signature, keyId, algorithm }`; save either as `receipt.json`. `json` is the RFC 8785 (JCS) text that Quant signed, and `signature` is base64 DER ECDSA P-256 over the SHA-256 of its UTF-8 bytes, with the same ledger key as the digests. Save the whole answer as `report.json` and run:

```bash
node verify.mjs verify-signed --doc report.json --public-key key.pem
# or, with several keys by keyId (a { keyId: pem } map, or { keyId, publicKeyPem } entries from the public-key route):
node verify.mjs verify-signed --doc report.json --public-keys keys.json
```

A valid document prints `signature valid`, then the verdict of the signed json, then the signed json (the only part to trust).

| Exit code | Output | Meaning |
| --- | --- | --- |
| 0 | `INTACT` | The report is complete and ok |
| 0 | `RECORDED` | Quant signed that the shred entries of this erasure are on the ledger record; prove each entry with the proof route or verify |
| 0 | `PURGED` | Quant signed that it deleted the archive objects of a deleted store that its manifest lists, and that both store prefixes were empty at `checkedAt` (an archive purge receipt) |
| 1 | `FAILED` | A shard failed (also in a report that is not complete) |
| 2 | usage message | Bad input: a missing option or an unreadable file |
| 3 | `INCOMPLETE` | The report covers part of its scope only (a run in progress or abandoned) |
| 3 | `FORKED-NOT-RECORDED` | The shred was made on a forked store: the key is destroyed, no shred entry was recorded (the re-shred after the fork is resolved has its own receipt) |
| 3 | `NOT-RECORDED` | The key is destroyed, but no shred entry could be appended (a `DROPPED` ledger) |
| 4 | `signature invalid: <reason>` | The document cannot be trusted |

For a receipt, the second line names the shred id, the store and ledger, `subjectRef`, `shreddedAt`, `fullyErasedAfter` and the number of shred entries, and the third line says what the verdict means. The verifier accepts receipts `v: 1` and `v: 2`. A `v: 2` receipt (written from the ledger subject release) adds `refKeyVersion`, a positive integer that is required, and it has no `backfilled` or `keyReissued` field. A `v: 1` receipt has no `refKeyVersion` and keeps its old rules. Any other `v` is refused. To prove an erasure, see [Prove an Erasure](https://docs.quantcdn.io/compute/kv-ledgers/#prove-an-erasure). A receipt is also checked for its shape (the known fields, ISO times, a 32-hex `subjectRef`, `entryCount` and `entriesSha256`, and, when `entries` is listed, that it matches both); a malformed receipt is `signature invalid: malformed receipt: …` (exit code 4). A receipt above 300 KB leaves `entries` out: fetch them from `GET .../shreds/{shredId}/entries`, save the pages (or the entries) as a JSON array, and add `--entries entries.json`; entries that do not hash to `entriesSha256` are exit code 4. A `v: 1` receipt of a record written by the one-time backfill has `backfilled: true`; with `keyReissued: true` the subject key was re-issued after the shred, so `shreddedAt` is the time of the earliest shred entry, not of the key's destruction, and the second line says so.

An archive purge receipt (`kv-ledger-archive-purge-receipt`) is Quant's signed record that it deleted the archive of a deleted store. It names the purge id, the org and the store, who asked and when, the store record (when the store was deleted and its ledgers), the digest chain (the number of digests, the first and last digest, and the SHA-256 of the last one), the deleted objects (counts, bytes, the latest retention date, and the manifest pages with their SHA-256), proof that both store prefixes held no object version and no delete marker, and the copies that remain until their dates (`residual`). To get it, call `GET .../kv/archives/{store_name}/purges/{purge_id}/receipt` and save the whole answer as `receipt.json`. Then run `verify-signed`. A valid receipt is `PURGED` (exit code 0). The second line reads `PURGED kv-ledger-archive-purge-receipt <purgeId> <org>/<store>: <count> objects, <bytes> bytes, completedAt <time>, last digest <name>`. The receipt times may have milliseconds or not. A malformed receipt is `signature invalid: malformed purge receipt: …` (exit code 4). `verify-signed` checks the signature and the shape only. To check the receipt against your own handoff copy of the archive, use `purge-check`.

`signature invalid` means a bad signature, a public key that is not P-256, a key that `keyId` does not name, json that is not in canonical form, an unknown document `type` (`kv-ledger-verification-report`, `kv-ledger-shred-receipt` and `kv-ledger-archive-purge-receipt` are known), or a `report` or `receipt` field that differs from `json`. Library: `verifySigned(doc, keys)` in `lib/signed.mjs` returns `{ ok: true, signed, verdict }` or `{ ok: false, reason }`; `DOCUMENT_TYPES` maps each known type to its verdict.

## Check a purge against your handoff (purge-check)

`purge-check` binds a purge receipt to the copy of the archive that you took before the store was deleted. It needs no network and no Quant account.

```bash
node verify.mjs purge-check <handoffDir> receipt.json manifest-00001.jsonl.gz [manifest-00002.jsonl.gz ...] --public-key key.pem
# or, with several keys by keyId:
node verify.mjs purge-check <handoffDir> receipt.json manifest-*.jsonl.gz --public-keys keys.json
```

Give exactly one of `--public-key` or `--public-keys`. The inputs are:

- `<handoffDir>` is the archive download taken before the store delete. It holds `ledgers/<org>/<store>/...` and `digests/<org>/<store>/...`, the same root that `--dir` reads. Files of other stores in the folder are ignored.
- `receipt.json` is the whole answer of `GET .../kv/archives/{store_name}/purges/{purge_id}/receipt`.
- The manifest pages are the files that the presigned URLs of `GET .../kv/archives/{store_name}/purges/{purge_id}/manifest` give. Each URL is valid for one hour. Keep the file names (`manifest-00001.jsonl.gz`, and so on). Give every page.

The command makes these checks:

1. The receipt signature is valid, and the receipt is an archive purge receipt.
2. Each page has the SHA-256 and the line count that the receipt lists for it. A page with another SHA-256 is not read. No page is missing, and no page is extra.
3. `manifestSha256` matches the manifest list (the signed receipt is refused otherwise).
4. The line counts of the pages add up to `objects.count`.
5. Every regular file in the handoff for this store has its key and its content SHA-256 in the manifest.
6. The newest digest in the handoff has the SHA-256 in `chain.lastDigestHash`. The newest digest is the last `.json` file, by byte order of name, in `digests/<org>/<store>/`.

| Exit code | Output | Meaning |
| --- | --- | --- |
| 0 | `OK purge <purgeId> <org>/<store>: ...` | All checks pass |
| 1 | one line per problem, then `NOT CONFIRMED: <n> problem(s)` | A check fails. A bad receipt signature is exit code 1 here (`signature invalid: <reason>`) |
| 2 | message on stderr | Bad input: a missing option, an unreadable file, a receipt that is not JSON, or a page that has the right SHA-256 but is not gzip JSON lines |

Each problem line names a file or a page and the check that failed. The command prints file paths, never file content.

What a pass proves: A receipt that verifies, checked with purge-check against your handoff copy, shows that Quant signed that it deleted every file of the archive you hold, and that both archive locations of the store were empty when it checked. It is Quant's signed statement, bound to your copy by hashes. It is not a proof that no copy exists anywhere: nobody can prove that data is absent. The copies that the receipt lists in `residual` remain until their dates.

The claim "every file of the archive you hold" holds when your handoff copy itself passes `verify` first. The newest digest that purge-check matches to `chain.lastDigestHash` then binds every earlier digest and entry of the chain.

What a pass does not prove: it does not prove that no other copy of the data exists. The copies that the receipt lists in `residual` remain until their dates. It does not prove that your handoff copy is complete if you took it before the last write. It does not prove the entries of the ledger; use `verify` and `verify-proof` for that.

## One inclusion proof (verify-proof)

An inclusion proof (`GET .../ledgers/{name}/proof?key=<key>`, or **Download proof (JSON)** in the dashboard) proves one entry without the rest of the chain. An agency can share one record and its proof, and the receiver checks it with no archive:

```bash
node verify.mjs verify-proof proof.json --public-keys public-key.json
# options: --public-key key.pem (instead of --public-keys), --entry entry.json, --anchor-dir <dir>, --anchor-copies <dir>, --tsa-root <pem> (tests only), --json
```

The verifier prints `PASS`, `FAIL` or `NOTE` for each step:

| Step | Check |
| --- | --- |
| 0 `status` | Only for a proof that cannot be checked: a pending proof (`{ "status": "pending" }`) is `FAIL ... pending: not yet verifiable` (exit code 1). A proof with a field missing or malformed (for example a `signature` that is not base64) is `FAIL ... malformed proof`, and a status other than `archived` is `FAIL ... is not "archived"` (both exit code 2). |
| 1 `entry hash` | The entry hash recomputes from the entry fields (byte layout `qkv-ledger-v1`, instance `<org>/<store>/<collection>#<shard>` from `digest`) and equals `hash` (and `entry.hash`). `entry.key`, when present, must be `<collection>:<id>`, because the key is not in the hash. With `--entry`, the entry in that file is recomputed instead: the record you hold must hash to the proven `hash`. |
| 2 `audit path` | `auditPath` folds from `hash` at `leafIndex` in a tree of `treeSize` leaves (RFC 9162) to `merkleRoot`. |
| 3 `digest` | `digest` lists the proof's `archiveKey` with that root, for the entry's collection and shard; `leafIndex` = entry `seq` − `fromSeq`; `treeSize` = `toSeq` − `fromSeq` + 1; the ledger `definitionHash` = SHA-256 of the JCS of its `definition`; `digestKey` is `digests/<org>/<store>/<period>[_n].json` of the same store. |
| 4 `signature` | `signature` (ECDSA P-256, DER, base64) verifies over the SHA-256 of the JCS bytes of `digest`. With `--public-keys` (the public-key route answer, or a `{ keyId: pem }` map) the key named by `keyId` is used; a `keyId` that the file does not name fails. With `--public-key`, that key is used whatever `keyId` says; the step line says so, so compare `keyId` yourself. |
| 5 `anchor` | Only with `--anchor-dir` or `--anchor-copies`, else a `NOTE` (not checked, no anchor yet, or `anchorUnavailable`). The binding is `proof.anchor.day`, or else the earliest `<day>.anchor.json` whose `digestKey` is the proof's digest or a later one. It must be well formed (the same rules as `--anchors`). It covers the proof's digest when its `digestHash` is SHA-256 of the proof's digest, or of a later digest that links back to it through `prevDigestHash`. Each listed type needs its evidence: `rfc3161` needs `<day>.tsr` with the full token check and imprint = `digestHash`; `customer-bucket` needs `--anchor-copies`, where the copy of the binding is byte-identical and the copy of the bound digest hashes to `digestHash`. Step 5 passes when no type fails and at least one type has evidence. |

Then `VERIFIED` (exit code 0) or `NOT VERIFIED: N step(s) failed` (exit code 1). Exit code 2 means bad input (a missing or repeated option, both or neither key option, an unreadable or non-JSON file, a malformed proof). `--json` prints `{ ok, status, entry: { key, collection, shard, seq }, digestKey, steps: [{ step, name, ok, note?, detail }] }`.

Anchor files:

- `--anchor-dir <dir>`: the store's `digests/<org>/<store>/anchors/` folder from the archive download (`<day>.anchor.json`, `<day>.tsr`). When the binding names a later digest, the digests from the proof's digest up to the bound digest must be in the parent folder (`digests/<org>/<store>/`). A missing or changed digest in that range breaks the chain and fails.
- `--anchor-copies <dir>`: the copy in your bucket (`<prefix><org>/<store>/`, or a folder with `<org>/<store>/` inside). Without `--anchor-dir`, the binding and the digest chain are read from the copy.

What one proof does not prove: it does not check the digest chain back to the store genesis, the entries before or after this one, or that the digest is the newest. Verify the archive for those. The entry is in its stored form, so personal fields stay encrypted and the check needs no subject key.

Library: `verifyProof({ proof, keys, entry?, anchorDir?, anchorCopiesDir?, tsaRootsPem? })` in `lib/proof.mjs`, where `keys` is one PEM or `{ keyId: pem }`. `fixtures/proof-real/` holds a real archived proof from a Quant smoke-test ledger (no customer data) and the public-key route answer that verifies it.

## Independent token check with OpenSSL

The verifier checks the token signature itself. For a second opinion, use OpenSSL with the certificate chain of the TSA:

```bash
openssl ts -verify -in 20261015.tsr -data digests/acme/audit/<digest named in 20261015.anchor.json>.json -CAfile tsa-chain.pem
```
