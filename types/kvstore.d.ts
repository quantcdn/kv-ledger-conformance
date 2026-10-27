// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The edge kvStore types, as a module. Source: the edge runtime type file of the same API surface. In an edge
// function, kvStore is a global of type KvStore.
/**
 * Type declarations for the Quant edge function KV store.
 *
 * `kvStore` and `KVStore` are the same object (KVStore is an alias, not a constructor).
 * Every method of `kvStore` takes the store id first. `kvStore.open(storeId)` returns a handle with the same
 * methods and no store id argument. Every error a method throws is a `kvStore.KVError` (an Error named 'KVError').
 * An edge function may use its project's own stores and linked stores only; any other store id is FORBIDDEN.
 */

/**
 * Error codes. The edge creates VALIDATION, FORBIDDEN, INTERNAL, RESPONSE_INVALID, UNAVAILABLE and NOT_FOUND;
 * the store returns the rest. HTTP status and retryable below are the usual values: always read `err.retryable`
 * and `err.status` from the error itself.
 */
export type KVErrorCode =
  /** 400, not retryable: the call has an invalid argument or option. Created at the edge or by the backend. */
  | 'VALIDATION'
  /** 403, not retryable: the function may not use this store. Only the project's own and linked stores are allowed. */
  | 'FORBIDDEN'
  /** Not retryable: an unexpected failure in the edge runtime. */
  | 'INTERNAL'
  /** Not retryable: the store answered with a body the edge cannot read. */
  | 'RESPONSE_INVALID'
  /** Usually 5xx or 429, usually retryable: the store did not answer in time or is busy. After a write the outcome can be unknown; retry an append or transaction only with the same idempotencyKey. From increment it is not retryable: the outcome is unknown and increment has no idempotencyKey, so a retry can count twice. */
  | 'UNAVAILABLE'
  /** 404, not retryable: a missing resource without a more specific code. */
  | 'NOT_FOUND'
  /** A size or count limit was hit, not retryable. Iteration over more pages than maxPages also throws it, with `cursor` set. */
  | 'LIMIT_EXCEEDED'
  /** 400, not retryable: the cursor is malformed, expired (24 h) or belongs to a different query. */
  | 'CURSOR_INVALID'
  /** The call needs a format 2 store; this store is format 1. Not retryable. */
  | 'REQUIRES_FORMAT_2'
  /** 404, not retryable: the key does not exist (for example an increment or a conditional write that needs it). */
  | 'KEY_NOT_FOUND'
  /** 404, not retryable: the store does not exist. */
  | 'STORE_NOT_FOUND'
  /** 409: a store upgrade conflicts with the request. Management code; the edge only passes it through. */
  | 'UPGRADE_CONFLICT'
  /** 409, not retryable as is: a condition failed (ifAbsent, ifVersion or a transaction check). `currentVersion` or `operation` can name the cause. */
  | 'CONFLICT'
  /** 409, retryable: another writer is busy on the same key or shard. Retry with a short delay. */
  | 'CONTENTION'
  /** 503, retryable: the store is being upgraded. Wait `retryAfter` seconds when present. */
  | 'STORE_MIGRATING'
  /** 409, not retryable: a unique index already holds this value. `existingKey` names the holder. */
  | 'UNIQUE_VIOLATION'
  /** 409, retryable: the index is still building. `index` and `state` name it. */
  | 'INDEX_NOT_READY'
  /** 400, not retryable: an index or where field covers an encrypted value. */
  | 'INDEX_FIELD_ENCRYPTED'
  /** 400, not retryable: a count index cannot cover a key that has a ttl. */
  | 'COUNT_WITH_TTL'
  /** 409: an export is running for the store. Management code; passed through. */
  | 'EXPORT_IN_PROGRESS'
  /** 404: the export does not exist. Management code; passed through. */
  | 'EXPORT_NOT_FOUND'
  /** 400, not retryable: a ledger entry cannot be changed or deleted. */
  | 'LEDGER_IMMUTABLE'
  /** 409, not retryable: the collection already holds non-ledger data. */
  | 'LEDGER_COLLECTION_NOT_EMPTY'
  /** 400, not retryable: this index kind is not allowed on a ledger collection. */
  | 'LEDGER_INDEX_KIND'
  /** 400, not retryable: the ledger needs a subject field that the entry lacks. */
  | 'LEDGER_SUBJECT_REQUIRED'
  /** 409, not retryable: the ledger is under retention. `retainUntil`, `collection` and `shard` can name the limit. */
  | 'LEDGER_RETAINED'
  /** 409, not retryable: the collection is a ledger, so the call is refused. */
  | 'LEDGER_PRESENT'
  /** 400, not retryable: the requested retention or order change goes the wrong way. Ledger settings only grow. */
  | 'LEDGER_DIRECTION'
  /** 409, retryable: the ledger is declared but not active yet. `activeAfter` gives the time. */
  | 'LEDGER_NOT_READY'
  /** 404, not retryable: no ledger with this name. */
  | 'LEDGER_NOT_FOUND'
  /** 404, not retryable: no entry for this subject. */
  | 'SUBJECT_NOT_FOUND'
  /** 409, not retryable: the store name is held by a retained ledger. */
  | 'STORE_NAME_RETAINED'
  /** 409, never retryable: the ledger chain has forked and the store refuses appends. `reason` names the cause. */
  | 'LEDGER_FORKED'
  /** 404, not retryable: no verification report. */
  | 'VERIFICATION_NOT_FOUND'
  /** 404, not retryable: no shred record. */
  | 'SHRED_NOT_FOUND'
  /** 409, never retryable: append to a dropped ledger. `ledger` names it. */
  | 'LEDGER_DROPPED'
  /** 409, not retryable: the ledger uses a retired subject format. Declare a new ledger. */
  | 'LEDGER_FORMAT_RETIRED';

/** The error every kvStore method throws. Detail fields are scalars and present only when the host reports them. */
export interface KVError extends Error {
  name: 'KVError';
  /** Machine-readable cause. Branch on this, not on `message`. */
  code: KVErrorCode;
  /** True when the same call can succeed on retry. An append without an idempotencyKey names the generated key in `idempotencyKey`. */
  retryable: boolean;
  /** HTTP status from the backend, when there is one. */
  status?: number;
  /** The key the error is about. */
  key?: string;
  /** The current version of the key, for a failed conditional write. Pass it as ifVersion after a re-read. */
  currentVersion?: string;
  /** A short cause, for example for LEDGER_FORKED. */
  reason?: string;
  /** Zero-based position of the failing operation in a transaction. */
  operation?: number;
  /** The index the error is about. */
  index?: string;
  /** The key that already holds the value, for UNIQUE_VIOLATION. */
  existingKey?: string;
  /** The state of an index or ledger, for example for INDEX_NOT_READY. */
  state?: string;
  /** When a declared ledger becomes active, for LEDGER_NOT_READY. */
  activeAfter?: string | number;
  /** The ledger collection the error is about. */
  collection?: string;
  /** The ledger shard the error is about. */
  shard?: string | number;
  /** When the retention ends, for LEDGER_RETAINED. */
  retainUntil?: string | number;
  /** For example 'use ttl (seconds)' when an expiry-like option name is used. */
  hint?: string;
  /** The key to pass again to retry an append or a transaction with an unknown outcome. */
  idempotencyKey?: string;
  /** The ledger name, for example with LEDGER_DROPPED. */
  ledger?: string;
  /** Seconds to wait before a retry. */
  retryAfter?: number | string;
  /**
   * Set when an iteration stopped at its page cap (LIMIT_EXCEEDED). Pass it as `cursor` to continue.
   * @example
   * try { for await (const item of kvStore.list('s', { prefix: 'a:' })) use(item); }
   * catch (e) { if (e instanceof kvStore.KVError && e.code === 'LIMIT_EXCEEDED') resume(e.cursor); else throw e; }
   */
  cursor?: string;
}

/**
 * The class behind every error. Use it for `instanceof` checks.
 * @example
 * try { await kvStore.get('s', 'k'); }
 * catch (e) { if (e instanceof kvStore.KVError) console.log(e.code, e.retryable); else throw e; }
 */
export interface KVErrorConstructor {
  new (code: KVErrorCode, message: string): KVError;
  readonly prototype: KVError;
}

/**
 * Options for set. Expiry-like names (expiration, expirationTtl, expires, expiresAt, expiresIn, ttlSeconds, maxAge)
 * throw VALIDATION with hint 'use ttl (seconds)'. Other unknown names warn in the function log and are ignored.
 * The platform will refuse unknown options (VALIDATION) from a published date.
 */
export interface SetOptions {
  /** Time to live in seconds, 60 to 31536000. The key disappears after it. */
  ttl?: number;
  /** Encrypt the value. */
  secret?: boolean;
  /** Write only if the key does not exist. Not with ifVersion. Throws CONFLICT when the key exists. */
  ifAbsent?: true;
  /** Write only if the key has this version (from getEntry). Not with ifAbsent. Throws CONFLICT on a mismatch. */
  ifVersion?: string;
}

/** Options for delete. Unknown names follow the same rule as SetOptions. */
export interface DeleteOptions {
  /** Delete only if the key has this version (from getEntry). Throws CONFLICT on a mismatch. */
  ifVersion?: string;
}

/** Result of a conditional set (ifAbsent or ifVersion). */
export interface ConditionalWriteResult {
  /** The version of the value just written. */
  version: string;
}

/** Options for get on a store handle. */
export interface GetOptions {
  /** Return the stored text without JSON parsing. Default false. Any other option name throws VALIDATION. */
  raw?: boolean;
}

export interface IncrementOptions {
  /** Time to live in seconds, 60 to 31536000. */
  ttl?: number;
}

/** A stored entry, from getEntry, getMany or getBy. */
export interface Entry {
  key: string;
  /** The decoded value. */
  value: unknown;
  /** True when the value is stored encrypted (set with secret: true). */
  encrypted?: boolean;
  /** Creation time, ISO 8601 text or epoch milliseconds. */
  createdAt?: string | number;
  /** Time of the last write. */
  updatedAt?: string | number;
  /** When the key expires, when it has a ttl. */
  expiresAt?: string | number;
  /** Pass to ifVersion or to atomic().check() for a conditional write. */
  version?: string;
  /** Ledger chain fields (shard, seq, hash, prevHash, ...) for an entry in a ledger collection. `subject` is `'pseudonym'` or `'clear'` when the ledger has a subject field; absent otherwise. In `'pseudonym'` mode the subject field of the value shows the original value you appended, or `{ $shredded: true }` after a shred. */
  ledger?: Record<string, unknown>;
}

/** One item of a list or search page. `value` is present with includeValues; an encrypted value shows '[ENCRYPTED]'. */
export interface QueryItem {
  key: string;
  /** True when the value is stored encrypted. */
  encrypted: boolean;
  /** The value, only with includeValues: true. */
  value?: unknown;
  /** Names of personal fields, for a ledger entry. */
  personal?: string[];
  createdAt?: string | number;
  updatedAt?: string | number;
  expiresAt?: string | number;
  version?: string;
  /** Ledger chain fields, for an entry in a ledger collection. Pass items to verifyChain. `subject` is `'pseudonym'` or `'clear'` when the ledger has a subject field; absent otherwise. In `'pseudonym'` mode the subject field of the value shows the original value you appended, or `{ $shredded: true }` after a shred. */
  ledger?: Record<string, unknown>;
}

export type ScalarValue = string | number | boolean | null;

export interface QueryOptions {
  /** Items per page, 1-1000, default 25. A page can hold fewer items: see QueryPage.pageEnd. */
  limit?: number;
  /** The cursor from the previous page. Valid for 24 hours. Iteration passes it for you. */
  cursor?: string;
  /** Include the value of each item. Default false. */
  includeValues?: boolean;
  /** Filter by storage kind. Default 'all'. */
  type?: 'all' | 'plaintext' | 'encrypted';
  /** Key prefix (1-512 characters). Not with pattern, collection or index. */
  prefix?: string;
  /** Collection (ledger) listing. At most 512 UTF-8 bytes. Not with prefix, pattern or index. */
  collection?: string;
  /** Collection range: ids that start with this text. Needs collection. Not with after, before, since or until. */
  startsWith?: string;
  /** Range: values after this one. Needs collection or index. Not with since or until. */
  after?: string | number | boolean | null;
  /** Range: values before this one. Needs collection or index. Not with since or until. */
  before?: string | number | boolean | null;
  /** Newest or highest first. Needs collection or index. */
  reverse?: boolean;
  /**
   * Ledger time window start, inclusive: epoch milliseconds or ISO 8601 with Z or an offset. Needs collection.
   * since and until cannot be combined with where, pattern, startsWith, after, before or type 'encrypted'.
   */
  since?: number | string;
  /** Ledger time window end, exclusive. Same rules as since. */
  until?: number | string;
  /** Index query. list only: search refuses index and equals. Not with collection, prefix, startsWith, since or until. */
  index?: string;
  /** Index fields to match (up to 3 scalars). Needs index; list only. May be omitted or {} for an index with no fields. */
  equals?: Record<string, ScalarValue>;
  /**
   * Field equalities (1 to 8 scalars) on values. Not with type 'encrypted', since or until.
   * On list it needs collection or index; search takes it alone.
   */
  where?: Record<string, ScalarValue>;
}

/** Options for search: as QueryOptions, but search refuses index and equals (VALIDATION). */
export interface SearchOptions extends QueryOptions {
  /** Key pattern (1-512 characters). Not with prefix, collection, since or until. */
  pattern?: string;
}

/** A page of list or search results. */
export interface QueryPage {
  items: QueryItem[];
  /** Pass to the next call to continue; null at the end. */
  cursor: string | null;
  /** True when more pages exist. A page can be empty and still have hasMore: true. */
  hasMore: boolean;
  /** Rows the backend scanned for this page (at most 10,000 per call). */
  scannedCount?: number;
  /** Present for collection and index queries. */
  indexed?: boolean;
  /**
   * Why the page ended: 'limit' (limit items reached), 'bytes' (the page size cap of 4 MiB),
   * 'budget' (the scan cap of 10,000 rows) or 'end' (no more data).
   */
  pageEnd?: 'limit' | 'bytes' | 'budget' | 'end';
}

/** Options for pages() and items(). */
export interface IterateOptions {
  /**
   * Security-relevant limit. Most pages one iteration fetches: integer 1-100, default 10.
   * When more pages remain, the iterator throws KVError LIMIT_EXCEEDED with `cursor` set.
   */
  maxPages?: number;
}

/**
 * What list and search return. It is the Promise of the first page, so `await` works as before.
 * It is also async-iterable over items, and has pages() and items().
 */
export interface PagedQuery extends Promise<QueryPage> {
  /**
   * Iterate over the items of every page, up to 10 pages.
   * @example
   * for await (const item of kvStore.list('s', { prefix: 'user:' })) console.log(item.key);
   */
  [Symbol.asyncIterator](): AsyncIterator<QueryItem>;
  /**
   * Iterate over pages. Each page is one request to the store.
   * @example
   * for await (const page of kvStore.list('s', { prefix: 'a:' }).pages({ maxPages: 20 })) console.log(page.items.length, page.pageEnd);
   */
  pages(options?: IterateOptions): AsyncIterable<QueryPage>;
  /**
   * Iterate over items, with a page cap.
   * @example
   * for await (const item of kvStore.search('s', { pattern: '*:2026-*' }).items({ maxPages: 50 })) console.log(item.key);
   */
  items(options?: IterateOptions): AsyncIterable<QueryItem>;
}

export interface CountOptions {
  /** The count index to read. */
  index: string;
  /** Index fields to match. */
  equals?: Record<string, ScalarValue>;
}

export interface AppendOptions {
  /**
   * 1-64 of [A-Za-z0-9_-]. Without one the host generates `q_` + 32 hex per call and names it on any error.
   * A repeat with the same key within 24 hours returns the first receipt with replayed: true.
   */
  idempotencyKey?: string;
}

/** Who wrote a ledger entry, as the platform stamped it. */
export interface LedgerSource {
  type: 'platform' | 'api' | 'dashboard' | 'edge';
  /** For `edge`: `<org>/<project>/<function id>`. */
  principal: string;
}

/**
 * A ledger append receipt.
 * `seq` and `prevHash` chain per `shard`. A total order exists only with `chains: 1`.
 * Across shards, order by `at`, then `shard`, then `id`.
 */
export interface AppendReceipt {
  /** The key of the entry. */
  key: string;
  /** The entry id (a ULID). */
  id: string;
  /** The shard that holds the entry: a two-digit string, '00' to '63'. */
  shard: string;
  /** Position in the chain of this shard, from 1. */
  seq: number;
  /** Append time: epoch milliseconds. The time part of `id`. */
  at: number;
  /** Hash of this entry. */
  hash: string;
  /** Hash of the previous entry in this shard. For seq 1 it is the genesis hash of the shard, never null. */
  prevHash: string;
  /** The ledger name. */
  ledger: string;
  /** Who appended, when reported. */
  source?: LedgerSource;
  /** True when an earlier call with the same idempotencyKey already stored this entry. */
  replayed?: true;
}

export interface LedgerShardStatus {
  collection: string;
  /** A two-digit string, '00' to '63'. */
  shard: string;
  /** Highest seq in this shard. */
  headSeq: number;
  /** Highest seq that is in the archive. */
  archivedSeq: number;
  /** Archive lag in seconds. */
  lag: number;
  /** Time of the head entry. */
  headAt?: number;
  /** Set when the shard reports a broken chain. */
  broken?: unknown;
}

/** Result of ledgerStatus (read-only). Sums are over the shards in `shards`. */
export interface LedgerStatus {
  name: string;
  state: string;
  collection: string;
  /** Number of chains (shards). A total order needs chains: 1. */
  chains: number;
  headSeq: number;
  archivedSeq: number;
  /** Largest archive lag in seconds over the shards. */
  lag: number;
  shards: LedgerShardStatus[];
  /** True when more shards exist than `shards` lists. */
  hasMoreShards: boolean;
  activeAfter?: string | number;
  retainUntil?: string | number;
  /** The last archive verification, when there is one. */
  lastVerify?: unknown;
}

/** The archived line of an entry, in its stored form. Personal fields stay sealed in `value`. */
export interface LedgerProofEntry {
  key: string;
  collection: string;
  /** A two-digit string. */
  shard: string;
  id: string;
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  /** The stored value as text. */
  value: string;
  prevHash: string;
  hash: string;
}

/** The daily anchor that covers the digest. */
export interface LedgerProofAnchor {
  /** The anchor type of the ledger when the binding lists it, else the first type of the binding. */
  type: 'rfc3161' | 'customer-bucket';
  /** The anchored UTC day, YYYYMMDD. */
  day: string;
  /** The key of the anchor binding. */
  bindingKey: string;
  /** The key of the RFC 3161 token, when one exists. */
  tokenKey?: string;
}

/** The proof of an entry that is not archived yet. It has no other field. */
export interface LedgerProofPending {
  status: 'pending';
}

/** The proof of an archived entry: a Merkle inclusion proof and the signed digest that holds the root. */
export interface LedgerProofArchived {
  status: 'archived';
  entry: LedgerProofEntry;
  /** The entry hash (the Merkle leaf input), 64 hex characters. */
  hash: string;
  /** Who wrote the entry. Absent for an entry written before provenance existed. */
  source?: LedgerSource;
  /** The archive period label, YYYYMMDDTHHmmZ. */
  period: string;
  /** The key of the archive object. */
  archiveKey: string;
  /** Position of the entry in the archive object, from 0. */
  leafIndex: number;
  /** Number of entries in the archive object. */
  treeSize: number;
  /** The Merkle root, 64 hex characters. */
  merkleRoot: string;
  /** The sibling hashes from the leaf to the root, 64 hex characters each. */
  auditPath: string[];
  /** The signed digest that holds `merkleRoot`. */
  digest: Record<string, unknown>;
  /** The key of the digest. */
  digestKey: string;
  /** Base64 DER ECDSA signature over the SHA-256 of the digest bytes. */
  signature: string;
  /** The id of the signing key. */
  keyId: string;
  /** When the digest was signed. Absent when the digest has no `signedAt`. */
  digestSignedAt?: string;
  /** The anchor that covers the digest. Absent when no anchor covers it yet, or when `anchorUnavailable` is true. */
  anchor?: LedgerProofAnchor;
  /** True only when the anchor lookup failed. The proof is valid; whether an anchor covers it is not known. */
  anchorUnavailable?: true;
}

/** Result of ledgerProof (read-only). Narrow on `status`. */
export type LedgerProof = LedgerProofPending | LedgerProofArchived;

export interface TransactionResult {
  /** The new version of each key the transaction wrote. */
  versions: Record<string, string>;
  /** True when the idempotencyKey matched an earlier commit. */
  replayed: boolean;
}

export interface CommitOptions {
  /** 1-64 of [A-Za-z0-9_-]. Retry an unknown outcome only with the same key. */
  idempotencyKey?: string;
}

/** Collects 1 to 25 operations and sends them as one transaction. All succeed or none does. */
export interface AtomicBuilder {
  /**
   * The key must still have this version; null means the key must not exist.
   * @example
   * kvStore.atomic('s').check('k', null).set('k', 1).commit();
   */
  check(key: string, version: string | null): AtomicBuilder;
  /**
   * Set a key. Options as for kvStore.set.
   * @example
   * kvStore.atomic('s').set('a', { n: 1 }, { ttl: 3600 }).commit();
   */
  set(key: string, value: unknown, options?: SetOptions): AtomicBuilder;
  /**
   * Delete a key.
   * @example
   * kvStore.atomic('s').delete('a', { ifVersion: v }).commit();
   */
  delete(key: string, options?: DeleteOptions): AtomicBuilder;
  /**
   * Add to a counter (default 1).
   * @example
   * kvStore.atomic('s').increment('visits', 2).commit();
   */
  increment(key: string, amount?: number): AtomicBuilder;
  /**
   * Send the operations. Throws VALIDATION when called a second time.
   * @example
   * const r = await kvStore.atomic('s').set('a', 1).set('b', 2).commit({ idempotencyKey: 'order-42' });
   */
  commit(options?: CommitOptions): Promise<TransactionResult>;
}

/**
 * A list item, getEntry result or append receipt; the chain fields may sit under `ledger`.
 * Any object is accepted: an entry without shard, seq, hash or prevHash is reported as 'missing-fields'.
 */
export type VerifiableEntry = object;

/** One problem found by verifyChain. */
export interface ChainProblem {
  /**
   * 'gap' (a seq is missing), 'fork' (two different entries share a seq), 'broken-link' (prevHash does not
   * match the previous hash) or 'missing-fields' (the entry lacks shard, seq, hash or prevHash).
   */
  problem: 'gap' | 'fork' | 'broken-link' | 'missing-fields' | (string & {});
  shard?: string | number;
  /** The seq where the problem shows. */
  seq?: number;
  /** Position in the input array, for missing-fields. */
  index?: number;
}

/**
 * Result of verifyChain. `ok` means no problem in the entries you passed. It does not prove the entries are
 * authentic: use ledgerProof for that.
 */
export interface ChainReport {
  ok: boolean;
  /** Entries counted in the shard summaries (duplicates and entries with missing fields excluded). */
  checked: number;
  /** One summary per shard, sorted by shard. */
  shards: Array<{ shard: string | number; first: number; last: number; count: number }>;
  problems: ChainProblem[];
}

/** The methods bound to one store. Same behaviour as the kvStore methods with the same name. */
export interface KvStoreHandle {
  /** The store id this handle uses. */
  readonly storeId: string;
  /**
   * Read a value. A missing key resolves to null. options: { raw: true } or a boolean returns the stored text.
   * @example
   * const kv = kvStore.open('s'); const user = await kv.get('user:1'); const text = await kv.get('user:1', { raw: true });
   */
  get(key: string, options?: GetOptions | boolean): Promise<any>;
  /**
   * Write a value.
   * @example
   * await kvStore.open('s').set('k', { a: 1 }, { ttl: 600 });
   */
  set(key: string, value: unknown, options?: SetOptions): Promise<boolean | ConditionalWriteResult>;
  /**
   * Delete a key.
   * @example
   * await kvStore.open('s').delete('k');
   */
  delete(key: string, options?: DeleteOptions): Promise<boolean>;
  /**
   * One page of keys, also async-iterable.
   * @example
   * for await (const item of kvStore.open('s').list({ prefix: 'a:' })) console.log(item.key);
   */
  list(options?: QueryOptions): PagedQuery;
  /**
   * Filtered keys, also async-iterable.
   * @example
   * const page = await kvStore.open('s').search({ where: { status: 'open' } });
   */
  search(options: SearchOptions): PagedQuery;
  /**
   * Atomic counter. An UNAVAILABLE error is not retryable: the outcome is unknown and a retry can count twice.
   * @example
   * const n = await kvStore.open('s').increment('hits');
   */
  increment(key: string, amount?: number, options?: IncrementOptions): Promise<number>;
  /**
   * Read a value with its metadata.
   * @example
   * const e = await kvStore.open('s').getEntry('k');
   */
  getEntry(key: string): Promise<Entry | null>;
  /**
   * Read up to 100 keys.
   * @example
   * const [a, b] = await kvStore.open('s').getMany(['a', 'b']);
   */
  getMany(keys: string[]): Promise<Array<Entry | null>>;
  /**
   * Unique index lookup.
   * @example
   * const e = await kvStore.open('s').getBy('by-email', { email: 'a@example.com' });
   */
  getBy(index: string, equals: Record<string, ScalarValue>): Promise<Entry | null>;
  /**
   * Count index read.
   * @example
   * const n = await kvStore.open('s').count({ index: 'by-status', equals: { status: 'open' } });
   */
  count(options: CountOptions): Promise<number>;
  /**
   * Append to a ledger collection. Throws LEDGER_DROPPED (409, never retryable) when the ledger was dropped.
   * @example
   * const r = await kvStore.open('s').append('audit', { action: 'login' }, { idempotencyKey: 'evt-1' });
   */
  append(collection: string, value: Record<string, unknown>, options?: AppendOptions): Promise<AppendReceipt>;
  /**
   * Ledger status (read-only).
   * @example
   * const st = await kvStore.open('s').ledgerStatus('audit');
   */
  ledgerStatus(name: string): Promise<LedgerStatus>;
  /**
   * Ledger proof for one entry (read-only).
   * @example
   * const p = await kvStore.open('s').ledgerProof('audit', receipt.key);
   */
  ledgerProof(name: string, key: string): Promise<LedgerProof>;
  /**
   * Start a transaction.
   * @example
   * await kvStore.open('s').atomic().set('a', 1).commit();
   */
  atomic(): AtomicBuilder;
  /**
   * Check ledger entries for gaps, forks and broken links. The same function as kvStore.verifyChain.
   * @example
   * const report = kvStore.open('s').verifyChain(page.items);
   */
  verifyChain(entries: ReadonlyArray<VerifiableEntry>): ChainReport;
}

export interface KvStore {
  /** The error class. Use `instanceof kvStore.KVError`. Not listed when you enumerate the methods. */
  readonly KVError: KVErrorConstructor;
  /**
   * Read a value. A missing key resolves to null. With skipDecode (any truthy value) the raw string is returned.
   * On a format 1 store a backend failure resolves to null instead of throwing.
   * @example
   * const user = await kvStore.get('s', 'user:1');
   */
  get(storeId: string, key: string, skipDecode?: boolean): Promise<any>;
  /**
   * Write a value. Resolves to true, or to { version } for a conditional write.
   * On a format 1 store a backend failure resolves to false instead of throwing.
   * @example
   * await kvStore.set('s', 'user:1', { name: 'Ada' }, { ttl: 3600 });
   * const r = await kvStore.set('s', 'lock', 1, { ifAbsent: true });
   */
  set(storeId: string, key: string, value: unknown, options?: SetOptions): Promise<boolean | ConditionalWriteResult>;
  /**
   * Delete a key. Resolves to true on success (false on a format 1 store failure).
   * @example
   * await kvStore.delete('s', 'user:1', { ifVersion: entry.version });
   */
  delete(storeId: string, key: string, options?: DeleteOptions): Promise<boolean>;
  /**
   * List keys, 1-1000 per page (default 25). The result is the first page and is also async-iterable.
   * @example
   * for await (const item of kvStore.list('s', { prefix: 'user:', includeValues: true })) console.log(item.key, item.value);
   */
  list(storeId: string, options?: QueryOptions): PagedQuery;
  /**
   * Search keys. Needs a prefix, pattern, where or type filter, or a collection.
   * @example
   * const page = await kvStore.search('s', { pattern: 'user:*:email', limit: 100 });
   */
  search(storeId: string, options: SearchOptions): PagedQuery;
  /**
   * Atomic counter. amount is a nonzero safe integer (default 1). Resolves to the new value.
   * An UNAVAILABLE error from increment is not retryable: the outcome is unknown and a retry can count twice.
   * @example
   * const views = await kvStore.increment('s', 'views', 1, { ttl: 86400 });
   */
  increment(storeId: string, key: string, amount?: number, options?: IncrementOptions): Promise<number>;
  /**
   * Read a value with its version and times. Missing key resolves to null.
   * @example
   * const e = await kvStore.getEntry('s', 'user:1');
   */
  getEntry(storeId: string, key: string): Promise<Entry | null>;
  /**
   * Read 1-100 keys in one call (at most 4 MiB). Same order as keys; null for a missing key.
   * @example
   * const [a, b] = await kvStore.getMany('s', ['a', 'b']);
   */
  getMany(storeId: string, keys: string[]): Promise<Array<Entry | null>>;
  /**
   * Unique index lookup. Missing resolves to null.
   * @example
   * const e = await kvStore.getBy('s', 'by-email', { email: 'a@example.com' });
   */
  getBy(storeId: string, index: string, equals: Record<string, ScalarValue>): Promise<Entry | null>;
  /**
   * Count the keys of a count index.
   * @example
   * const n = await kvStore.count('s', { index: 'by-status', equals: { status: 'open' } });
   */
  count(storeId: string, options: CountOptions): Promise<number>;
  /**
   * Append an entry to a ledger collection (at most 512 UTF-8 bytes; value a plain object of at most 350,000 bytes).
   * Timeout 11 s. Without an idempotencyKey the host generates one per call and puts it on any error,
   * so an unknown outcome is retryable with that key.
   * Throws LEDGER_DROPPED (409, never retryable) when the ledger was dropped.
   * @example
   * const r = await kvStore.append('s', 'audit', { action: 'login', user: 'u1' }, { idempotencyKey: 'login-u1-1' });
   */
  append(storeId: string, collection: string, value: Record<string, unknown>, options?: AppendOptions): Promise<AppendReceipt>;
  /**
   * Status of a ledger (read-only).
   * @example
   * const st = await kvStore.ledgerStatus('s', 'audit');
   */
  ledgerStatus(storeId: string, name: string): Promise<LedgerStatus>;
  /**
   * Proof state of one ledger entry (read-only). 'pending' until the entry is archived.
   * @example
   * const proof = await kvStore.ledgerProof('s', 'audit', receipt.key);
   */
  ledgerProof(storeId: string, name: string, key: string): Promise<LedgerProof>;
  /**
   * Start a transaction of 1-25 operations.
   * @example
   * await kvStore.atomic('s').check('a', v).set('a', 2).increment('n').commit();
   */
  atomic(storeId: string): AtomicBuilder;
  /**
   * A handle bound to one store: the same methods without the storeId argument. Makes no request.
   * A storeId that is not a string throws VALIDATION. A store the function may not use fails on its first call (FORBIDDEN).
   * @example
   * const kv = kvStore.open('s'); await kv.set('k', 1);
   */
  open(storeId: string): KvStoreHandle;
  /**
   * Check ledger entries or receipts for gaps, forks and broken links, per shard. Runs locally, no request.
   * Takes an array of at most 10,000 entries, else VALIDATION. It does NOT prove the entries are authentic:
   * use ledgerProof for that.
   * @example
   * const page = await kvStore.list('s', { collection: 'audit', includeValues: true });
   * const report = kvStore.verifyChain(page.items);
   */
  verifyChain(entries: ReadonlyArray<VerifiableEntry>): ChainReport;
}
