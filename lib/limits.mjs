// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Every limit the suite uses. Cases read numbers only from here.
// Sources: API page = the edge kvStore API page; d.ts = kvstore.d.ts; ledgers page = the KV ledgers docs page;
// stores page = the KV stores docs page; backend = observed backend behaviour (page budget, size check).
const MiB = 1024 * 1024;
const HOUR_MS = 3600000;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || value instanceof RegExp) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const EXPIRY_HINT = 'use ttl (seconds)';

export const LIMITS = deepFreeze({
  storeId: /^[A-Za-z0-9_-]{1,255}$/, // API page
  keyMaxBytes: 2048, // API page
  idMaxBytes: 1000, // API page: format 2, text after the last ':'
  itemMaxBytes: 400 * 1024, // API page: 409,600
  ttl: { min: 60, max: 31536000 }, // d.ts
  expiryOptionNames: [
    'expiration', 'expirationTtl', 'expires', 'expiresAt', 'expiresIn', 'ttlSeconds', 'maxAge',
  ], // d.ts: these names throw VALIDATION with the hint
  expiryHint: EXPIRY_HINT, // d.ts
  getMany: { minKeys: 1, maxKeys: 100, maxBytes: 4 * MiB }, // d.ts, backend batch-get
  transaction: { minOps: 1, maxOps: 25 }, // d.ts
  idempotencyKey: {
    pattern: /^[A-Za-z0-9_-]{1,64}$/,
    maxLength: 64,
    replayWindowMs: 24 * HOUR_MS,
    autoPattern: /^q_[0-9a-f]{32}$/,
  }, // d.ts
  listLimit: { min: 1, max: 1000, default: 25 }, // d.ts
  pageBytesEdge: 4 * MiB, // d.ts: 4,194,304
  pageBytesBudget: 4000000, // backend page budget, under the edge cap
  scannedRowsPerPage: 10000, // d.ts
  shortPagesBudgetMax: 10, // suite: capability shortPages means a page scan budget of at most this many rows
  pageEnd: ['limit', 'bytes', 'budget', 'end'], // d.ts
  maxPages: { min: 1, max: 100, default: 10 }, // d.ts
  verifyChainMaxEntries: 10000, // d.ts
  prefixPattern: { min: 1, max: 512 }, // d.ts: characters
  whereFields: { min: 1, max: 8 }, // d.ts
  equalsFields: { max: 3 }, // d.ts
  fieldName: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, // stores page: where (and index equals) field names
  reservedFieldNames: ['__proto__', 'constructor', 'prototype'], // stores page: refused as field names
  fieldStringMaxChars: 512, // stores page: a where/equals string value, in characters
  cursorLifetimeMs: 24 * HOUR_MS, // d.ts
  ledgerCollectionMaxBytes: 512, // d.ts
  ledgerValueMaxBytes: 350000, // backend append: size check on the stored envelope, which includes source
  ledgerChains: { min: 1, max: 64 }, // ledgers page
  ledgerName: NAME, // ledgers page
  indexName: NAME, // stores page
  indexFields: { min: 0, max: 3 }, // stores page: index fields; a unique index needs at least 1
  indexesPerStore: 20, // stores page: more is LIMIT_EXCEEDED
  indexesPerCollection: 5, // stores page: indexes that cover one collection; more is LIMIT_EXCEEDED
  indexActivationMs: 75000, // stores page: the backfill starts about 75 s after the declaration
  ledgerActivationMs: 75000, // ledgers page
  activationMarginMs: 15000, // suite: time a case allows over a declaration's activation delay
  ledgerRetentionDays: { min: 1, max: 36500 }, // ledgers page
  ledgerPersonalFieldsMax: 20, // ledgers page: personalFields
  ledgersPerStore: 20, // ledgers page: more is LIMIT_EXCEEDED
  ledgerSubjectMaxBytes: 256, // ledgers page: the subject field value, UTF-8
  archivePeriodMs: 300000, // ledgers page
  archiveDelayMs: 60000, // ledgers page: a period is archived from 60 seconds after it closes
  archiveObjectMaxEntries: 10000, // ledgers page: entries per archive object
  timeoutsMs: { default: 8000, append: 11000 }, // API page
});
