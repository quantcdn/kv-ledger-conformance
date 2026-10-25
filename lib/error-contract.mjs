// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// One row per KVErrorCode of kvstore.d.ts: status (null when the d.ts gives none), retryable (true, false or
// 'varies'), and the detail fields the d.ts names for the code.
export const DETAIL_FIELDS = Object.freeze([
  'key', 'currentVersion', 'reason', 'operation', 'index', 'existingKey', 'state', 'activeAfter',
  'collection', 'shard', 'retainUntil', 'hint', 'idempotencyKey', 'ledger', 'retryAfter', 'cursor',
]);

// [code, status, retryable, details]
const TABLE = [
  ['VALIDATION', 400, false, []],
  ['FORBIDDEN', 403, false, []],
  ['INTERNAL', null, false, []],
  ['RESPONSE_INVALID', null, false, []],
  ['UNAVAILABLE', null, 'varies', []],
  ['NOT_FOUND', 404, false, []],
  ['LIMIT_EXCEEDED', null, false, ['cursor']],
  ['CURSOR_INVALID', 400, false, []],
  ['REQUIRES_FORMAT_2', 400, false, []],
  ['KEY_NOT_FOUND', 404, false, []],
  ['STORE_NOT_FOUND', 404, false, []],
  ['UPGRADE_CONFLICT', 409, false, []],
  ['CONFLICT', 409, false, ['key', 'currentVersion', 'reason', 'operation']],
  ['CONTENTION', 409, true, []],
  ['STORE_MIGRATING', 503, true, ['retryAfter']],
  ['UNIQUE_VIOLATION', 409, false, ['index', 'existingKey']],
  ['INDEX_NOT_READY', 409, true, ['index', 'state']],
  ['INDEX_FIELD_ENCRYPTED', 400, false, []],
  ['COUNT_WITH_TTL', 400, false, []],
  ['EXPORT_IN_PROGRESS', 409, false, []],
  ['EXPORT_NOT_FOUND', 404, false, []],
  ['LEDGER_IMMUTABLE', 400, false, []],
  ['LEDGER_COLLECTION_NOT_EMPTY', 409, false, ['reason']],
  ['LEDGER_INDEX_KIND', 400, false, []],
  ['LEDGER_SUBJECT_REQUIRED', 400, false, []],
  ['LEDGER_RETAINED', 409, false, ['retainUntil', 'reason', 'collection', 'shard']],
  ['LEDGER_PRESENT', 409, false, []],
  ['LEDGER_DIRECTION', 400, false, []],
  ['LEDGER_NOT_READY', 409, true, ['activeAfter']],
  ['LEDGER_NOT_FOUND', 404, false, []],
  ['SUBJECT_NOT_FOUND', 404, false, []],
  ['STORE_NAME_RETAINED', 409, false, []],
  ['LEDGER_FORKED', 409, false, ['reason']],
  ['VERIFICATION_NOT_FOUND', 404, false, []],
  ['SHRED_NOT_FOUND', 404, false, []],
  ['LEDGER_DROPPED', 409, false, ['ledger']],
  ['LEDGER_FORMAT_RETIRED', 409, false, []],
];

const row = ([, status, retryable, details]) => Object.freeze({ status, retryable, details: Object.freeze(details) });

export const ERROR_CODES = Object.freeze(Object.fromEntries(TABLE.map((t) => [t[0], row(t)])));
