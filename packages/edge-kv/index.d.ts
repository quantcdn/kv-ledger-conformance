// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import type { KVError, KVErrorConstructor, KvStore } from './types/kvstore.js';

export * from './types/kvstore.js';

export interface Clock {
  now(): number;
}

export interface RealClock extends Clock {
  readonly virtual: false;
  /** Waits ms milliseconds. */
  advance(ms: number): Promise<void>;
}

export interface VirtualClock extends Clock {
  readonly virtual: true;
  /** Moves the clock at once. */
  advance(ms: number): Promise<void>;
  set(ms: number): void;
}

/** A JSON-safe copy of the backend state: stores, indexes, ledgers, idempotency records, archives, local keys. */
export interface Snapshot {
  v: number;
  [field: string]: unknown;
}

interface StorageBase {
  /** Sync. The snapshot, or null. Called at create, after changed() returns true, and after a failed save. */
  load(): Snapshot | null;
  /** Sync. Called before reads (and, without transaction, before writes). true: the backend reloads with load(). */
  changed?(): boolean;
}

/** Saves after each write, also a write that throws. One process, or several with changed() and no overlap. */
export interface SaveStorage extends StorageBase {
  save(snapshot: Snapshot): void;
}

/**
 * Each write calls transaction(run). Take the lock, load the fresh snapshot (or null), call run, save the
 * snapshot that run returns, then release the lock. With it, the backend writes return promises. Do not call a
 * backend write from inside transaction: it waits for its own lock.
 */
export interface TransactionStorage extends StorageBase {
  transaction(run: (fresh: Snapshot | null) => Promise<Snapshot>): Promise<void>;
  save?(snapshot: Snapshot): void;
}

/** The storage hook. The backend does no I/O: the hook does it. */
export type Storage = SaveStorage | TransactionStorage;

export type IndexState = 'BUILDING' | 'ACTIVE' | 'FAILED';

export interface IndexSettings {
  /** 'ACTIVE': a new index is ACTIVE at once (the backfill check still runs). Default 'BUILDING'. */
  initialState?: 'BUILDING' | 'ACTIVE';
  /** The time a new index stays BUILDING. Default 75000. */
  activationMs?: number;
  /** A list by index leaves out an item until listLagMs after its last write. Default 0. */
  listLagMs?: number;
}

export interface LocalBackendOptions {
  /** Default: the real clock (createLocalKv); required for createLocalBackend. */
  clock?: Clock;
  KVError?: KVErrorConstructor;
  /** Scan budget for each list or search page. */
  budgetRows?: number;
  /** Seed of the ledger shard choice. Default 1. */
  seed?: number;
  /** The org of the identity in ledger entry sources. Default 'local-org'. */
  org?: string;
  /** Local keys: base64 secret and cursor keys, and the PKCS#8 PEM of the P-256 archive signing key. */
  keys?: { secret?: string; cursor?: string; proof?: string };
  storage?: Storage;
  indexes?: IndexSettings;
}

/** A result, or a promise of it when the storage hook has transaction. */
export type MaybePromise<T> = T | Promise<T>;

export interface IndexDefinition {
  name: string;
  collection: string;
  fields: string[];
  sortBy?: string;
  unique?: boolean;
  count?: boolean;
}

export interface LedgerDefinition {
  name: string;
  collection: string;
  chains?: number;
  retentionDays?: number;
  lockMode?: 'governance' | 'compliance';
  /** Fields sealed with the subject's key. They need subjectField. */
  personalFields?: string[];
  /** The field that holds the data subject id. */
  subjectField?: string;
  /** With subjectField. Default 'pseudonym': the field stores a token and reads show the value as appended. Immutable. */
  subjectMode?: 'pseudonym' | 'clear';
  /** With subjectField. Default 'exact'; 'fold' makes the id case-insensitive. Immutable. */
  subjectCase?: 'exact' | 'fold';
  [field: string]: unknown;
}

/** The body of a shred, as the platform route POST …/ledgers/{name}/shred takes it. */
export interface ShredRequest {
  subjectId: string | number;
  reason: string;
  authority: string;
  requestedBy: string;
}

/** The shred receipt: `json` (RFC 8785) signed with the local archive key. Check it with verify.mjs verify-signed. */
export interface SignedReceipt {
  json: string;
  signature: string;
  keyId: string;
  algorithm: 'ECDSA_SHA_256';
}

export interface ShredResult {
  ledger: string;
  subjectRef: string;
  refKeyVersion: number;
  shredId: string;
  /** The receipts of the shred entries this call appended (empty on a repeat). */
  entries: Array<Record<string, unknown>>;
  shreddedAt: string;
  fullyErasedAfter: string;
  receipt: SignedReceipt;
  alreadyShredded?: true;
}

/** The body of POST …/ledgers/{name}/subject-entries. since and until: epoch ms or ISO 8601. */
export interface SubjectEntriesRequest {
  subjectId: string | number;
  collection?: string;
  since?: number | string;
  until?: number | string;
  /** 1 to 1000. Default 100. */
  limit?: number;
  nextToken?: string;
  /** Default 'decrypted'. */
  personal?: 'decrypted' | 'sealed';
}

export interface SubjectEntries {
  ledger: string;
  subjectState: 'live' | 'shredded';
  entries: Array<{ key: string; value: unknown; encrypted: false; created_at: string; updated_at: string;
    ledger: Record<string, unknown>; personal?: string[] }>;
  complete: boolean;
  nextToken?: string;
  /** Only when shredded: the erasure record ids. */
  shreds?: string[];
  earlierGenerationsShredded: number;
}

/** The admin and control surface of the local backend. The kvStore methods use the rest. */
export interface LocalBackend {
  createStore(store: { id: string; format?: 1 | 2 }): MaybePromise<{ id: string; format: number }>;
  deleteStore(id: string): MaybePromise<true>;
  storeIds(): string[];
  storeFormat(id: string): number;
  reset(): MaybePromise<void>;
  declareIndex(storeId: string, def: IndexDefinition, options?: { wait?: boolean }): MaybePromise<{ name: string; state: IndexState; error?: string }>;
  dropIndex(storeId: string, name: string): MaybePromise<true>;
  /** Holds the index in the state until the next call. 'ACTIVE' skips the backfill check. */
  setIndexState(storeId: string, name: string, state: IndexState): MaybePromise<{ name: string; state: IndexState }>;
  declareLedger(storeId: string, def: LedgerDefinition, options?: { wait?: boolean }): MaybePromise<{ activeAfter: string; [field: string]: unknown }>;
  dropLedger(storeId: string, name: string): MaybePromise<unknown>;
  /** Shreds a data subject of a ledger: shred entries, then the key is destroyed. A write. */
  shred(storeId: string, ledger: string, body: ShredRequest): MaybePromise<ShredResult>;
  /** The entries of one data subject (the live key generation), or the erasure records of a shredded one. A read. */
  subjectEntries(storeId: string, ledger: string, body: SubjectEntriesRequest): SubjectEntries;
  /** Archives every unarchived ledger entry of the store now. */
  archiveNow(storeId: string): MaybePromise<true>;
  /** The PEM of the local P-256 key that signs the archive digests. */
  publicKey(): string;
  /** The next call of op fails: 'before' (nothing written) or 'after-write' (written, then UNAVAILABLE). */
  injectFault(fault: { op: string; when: 'before' | 'after-write' }): void;
  /** Server time: the clock plus the offset that setClock sets. */
  now(): number;
  /** A write: the offset is in the snapshot. */
  setClock(ms: number): MaybePromise<void>;
  snapshot(): Snapshot;
  restore(snapshot: Snapshot): void;
  [method: string]: unknown;
}

export interface LocalKvOptions extends LocalBackendOptions {
  /** The stores the function may use. Default: every store of the backend. Others are FORBIDDEN. */
  isAllowed?(storeId: string): boolean;
  /** Called with a message for each unknown set or delete option. */
  warn?(message: string): void;
}

export function createLocalKv(options?: LocalKvOptions): {
  kvStore: KvStore;
  backend: LocalBackend;
  KVError: KVErrorConstructor;
};

export function createLocalBackend(options: LocalBackendOptions & { clock: Clock }): LocalBackend;
export function createKVErrorClass(): KVErrorConstructor;
export function createRealClock(): RealClock;
export function createVirtualClock(startMs?: number): VirtualClock;

/** Lower-level parts, for an emulator with its own allow-list. createLocalKv composes them. */
export function createEdgeChecks(KVError: KVErrorConstructor): unknown;
export function createEdgeCalls(options: {
  backend: LocalBackend;
  checks: unknown;
  KVError: KVErrorConstructor;
  isAllowed(storeId: string): boolean;
  warn?(message: string): void;
}): unknown;
export function buildKvStore(calls: unknown, KVError: KVErrorConstructor): KvStore;

export const LIMITS: Readonly<Record<string, unknown>>;
export const ERROR_CODES: Readonly<Record<string, {
  status: number | null;
  /** 'varies': read err.retryable (UNAVAILABLE). */
  retryable: boolean | 'varies' | null;
  /** The detail fields the error can carry. */
  details: readonly string[];
}>>;

export type { KVError };
