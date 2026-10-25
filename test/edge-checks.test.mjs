// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEdgeChecks } from '../lib/edge-checks.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { LIMITS, EXPIRY_HINT } from '../lib/limits.mjs';

const KVError = createKVErrorClass();
const checks = createEdgeChecks(KVError);

const L = LIMITS;
const str = (n, ch = 'a') => ch.repeat(n);
// The largest count of a {min,max} quantifier in a limit pattern, so no test writes the number.
const patternMax = (re) => Number(/\{\d+,(\d+)\}/.exec(re.source)[1]);
const fields = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, i]));

function assertValidation(fn, extra = {}) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof KVError, 'instanceof the given KVError class');
    assert.equal(err.name, 'KVError');
    assert.equal(err.code, 'VALIDATION');
    assert.equal(err.retryable, false);
    assert.equal(err.status, undefined, 'edge VALIDATION has no status');
    for (const [k, v] of Object.entries(extra)) assert.equal(err[k], v, k);
    return true;
  });
}

const tableTest = (title, rows, call, extra) => {
  for (const [name, ...args] of rows) {
    test(`${title}: ${name}`, () => assertValidation(() => call(...args), extra));
  }
};

const okTest = (title, rows, call) => {
  for (const [name, ...args] of rows) {
    test(`${title} accepts: ${name}`, () => assert.doesNotThrow(() => call(...args)));
  }
};

test('createEdgeChecks returns frozen functions and uses the class it is given', () => {
  assert.ok(Object.isFrozen(checks));
  const Other = createKVErrorClass();
  assert.throws(() => createEdgeChecks(Other).checkStoreId(1), (e) => e instanceof Other && !(e instanceof KVError));
});

test('createEdgeChecks refuses a non-function class', () => {
  assert.throws(() => createEdgeChecks(null), TypeError);
});

// ---- store id ----
tableTest('checkStoreId', [
  ['not a string', 12],
  ['empty', ''],
  ['slash', 'a/b'],
  ['too long', str(patternMax(L.storeId) + 1)],
], checks.checkStoreId);
okTest('checkStoreId', [['plain', 'my-store_1']], checks.checkStoreId);

// ---- keys ----
const id = (n) => str(n, 'i');
tableTest('checkKey', [
  ['not a string', 5],
  ['empty', ''],
  ['over keyMaxBytes', `c:${id(L.keyMaxBytes - 1)}`],
  ['over keyMaxBytes by multibyte', `c:${str(Math.floor(L.keyMaxBytes / 2), 'é')}`],
  ['starts with colon', ':a'],
  ['ends with colon', 'a:'],
  ['id over idMaxBytes', `c:${id(L.idMaxBytes + 1)}`],
  ['no colon, id over idMaxBytes', id(L.idMaxBytes + 1)],
], (k) => checks.checkKey(k, { format: 2 }));
okTest('checkKey', [
  ['simple', 'a'],
  ['nested', 'a:b:c'],
  ['keyMaxBytes exactly with id that fits', `${str(L.keyMaxBytes - L.idMaxBytes - 1, 'c')}:${id(L.idMaxBytes)}`],
], (k) => checks.checkKey(k, { format: 2 }));
okTest('checkKey format 1', [['colon edges', ':a:'], ['long id', id(L.idMaxBytes + 1)]], (k) => checks.checkKey(k, { format: 1 }));
test('checkKey defaults to format 2', () => assertValidation(() => checks.checkKey(':a')));
tableTest('checkKey format 1', [['empty', ''], ['too long', id(L.keyMaxBytes + 1)]], (k) => checks.checkKey(k, { format: 1 }));

// ---- set options ----
tableTest('checkSetOptions', [
  ['not an object', 5],
  ['null', null],
  ['array', []],
  ['ttl under min', { ttl: L.ttl.min - 1 }],
  ['ttl over max', { ttl: L.ttl.max + 1 }],
  ['ttl not integer', { ttl: L.ttl.min + 0.5 }],
  ['ttl string', { ttl: String(L.ttl.min) }],
  ['secret not boolean', { secret: 'yes' }],
  ['ifAbsent false', { ifAbsent: false }],
  ['ifAbsent truthy non-true', { ifAbsent: 1 }],
  ['ifVersion empty', { ifVersion: '' }],
  ['ifVersion not string', { ifVersion: 3 }],
  ['ifAbsent with ifVersion', { ifAbsent: true, ifVersion: 'v1' }],
], checks.checkSetOptions);
for (const name of L.expiryOptionNames) {
  test(`checkSetOptions: expiry-like name ${name} has the hint`, () => {
    assertValidation(() => checks.checkSetOptions({ [name]: L.ttl.min }), { hint: EXPIRY_HINT });
  });
}
test('checkSetOptions returns unknown names (warn phase)', () => {
  assert.deepEqual(checks.checkSetOptions({ mode: 'x', ttl: L.ttl.min, other: 1 }), { unknown: ['mode', 'other'] });
  assert.deepEqual(checks.checkSetOptions(undefined), { unknown: [] });
});
okTest('checkSetOptions', [
  ['ttl bounds min', { ttl: L.ttl.min }],
  ['ttl bounds max', { ttl: L.ttl.max }],
  ['all valid', { secret: true, ifAbsent: true }],
  ['ifVersion', { ifVersion: 'v1', secret: false }],
  ['undefined values are absent', { ttl: undefined, ifAbsent: true, ifVersion: undefined }],
], checks.checkSetOptions);

// ---- delete options ----
tableTest('checkDeleteOptions', [
  ['not an object', 'x'],
  ['ifVersion empty', { ifVersion: '' }],
  ['ifVersion number', { ifVersion: 1 }],
], checks.checkDeleteOptions);
for (const name of L.expiryOptionNames) {
  test(`checkDeleteOptions: expiry-like name ${name} has the hint`, () => {
    assertValidation(() => checks.checkDeleteOptions({ [name]: 1 }), { hint: EXPIRY_HINT });
  });
}
test('checkDeleteOptions returns unknown names, including ttl', () => {
  assert.deepEqual(checks.checkDeleteOptions({ ifVersion: 'v', ttl: L.ttl.min }), { unknown: ['ttl'] });
  assert.deepEqual(checks.checkDeleteOptions(), { unknown: [] });
});

// ---- increment ----
tableTest('checkIncrement', [
  ['bad key', '', 1, undefined],
  ['amount zero', 'k', 0, undefined],
  ['amount fraction', 'k', 1.5, undefined],
  ['amount string', 'k', '1', undefined],
  ['amount unsafe', 'k', Number.MAX_SAFE_INTEGER + 1, undefined],
  ['amount NaN', 'k', NaN, undefined],
  ['options not object', 'k', 1, 'x'],
  ['ttl under min', 'k', 1, { ttl: L.ttl.min - 1 }],
  ['ttl over max', 'k', 1, { ttl: L.ttl.max + 1 }],
  ['unknown option', 'k', 1, { mode: 'x' }],
], checks.checkIncrement);
test('checkIncrement: expiry-like name has the hint', () => {
  assertValidation(() => checks.checkIncrement('k', 1, { [L.expiryOptionNames[0]]: L.ttl.min }), { hint: EXPIRY_HINT });
});
okTest('checkIncrement', [
  ['default amount', 'k', undefined, undefined],
  ['negative', 'k', -3, undefined],
  ['ttl', 'k', 2, { ttl: L.ttl.min }],
], checks.checkIncrement);

// ---- getMany ----
const keys = (n) => Array.from({ length: n }, (_, i) => `k${i}`);
tableTest('checkGetMany', [
  ['not an array', 'k'],
  ['under minKeys', keys(L.getMany.minKeys - 1)],
  ['over maxKeys', keys(L.getMany.maxKeys + 1)],
  ['non-string key', ['a', 2]],
  ['empty key', ['a', '']],
  ['key over keyMaxBytes', ['a', id(L.keyMaxBytes + 1)]],
], checks.checkGetMany);
okTest('checkGetMany', [['minKeys', keys(L.getMany.minKeys)], ['maxKeys', keys(L.getMany.maxKeys)]], checks.checkGetMany);

// ---- query options ----
const list = (o) => checks.checkQueryOptions(o, { search: false });
const search = (o) => checks.checkQueryOptions(o, { search: true });
const ISO = '2026-10-01T00:00:00Z';
const ISO2 = '2026-10-02T00:00:00+10:00';

tableTest('checkQueryOptions (list)', [
  ['not an object', 'x'],
  ['array', []],
  ['unknown option', { bogus: 1 }],
  ['pattern on list', { pattern: 'a*' }],
  ['limit under min', { limit: L.listLimit.min - 1 }],
  ['limit over max', { limit: L.listLimit.max + 1 }],
  ['limit not integer', { limit: L.listLimit.min + 1.5 }],
  ['limit string', { limit: '5' }],
  ['cursor empty', { cursor: '' }],
  ['cursor not string', { cursor: 5 }],
  ['includeValues not boolean', { includeValues: 'yes' }],
  ['type unknown', { type: 'secret' }],
  ['prefix empty', { prefix: '' }],
  ['prefix too long', { prefix: str(L.prefixPattern.max + 1) }],
  ['prefix not string', { prefix: 5 }],
  ['collection not string', { collection: 5 }],
  ['collection too many bytes', { collection: str(L.ledgerCollectionMaxBytes + 1) }],
  ['prefix with collection', { prefix: 'a', collection: 'c' }],
  ['prefix with index', { prefix: 'a', index: 'byX' }],
  ['collection with index', { collection: 'c', index: 'byX' }],
  ['startsWith without collection', { startsWith: 'a' }],
  ['startsWith with after', { collection: 'c', startsWith: 'a', after: 'b' }],
  ['startsWith with before', { collection: 'c', startsWith: 'a', before: 'b' }],
  ['startsWith with index', { index: 'byX', startsWith: 'a' }],
  ['startsWith with colon', { collection: 'c', startsWith: 'a:b' }],
  ['startsWith empty', { collection: 'c', startsWith: '' }],
  ['after without collection or index', { after: 'a' }],
  ['before without collection or index', { before: 'a' }],
  ['reverse without collection or index', { reverse: true }],
  ['reverse not boolean', { collection: 'c', reverse: 'yes' }],
  ['collection bound with colon', { collection: 'c', after: 'a:b' }],
  ['collection bound not string', { collection: 'c', before: 5 }],
  ['collection bound id too long', { collection: 'c', after: id(L.idMaxBytes + 1) }],
  ['after not before before', { collection: 'c', after: 'b', before: 'a' }],
  ['after equal to before', { collection: 'c', after: 'b', before: 'b' }],
  ['index bound not scalar', { index: 'byX', after: { a: 1 } }],
  ['since without collection', { since: ISO }],
  ['until without collection', { until: ISO }],
  ['since with index', { index: 'byX', since: ISO }],
  ['since zone-less ISO', { collection: 'c', since: '2026-10-01T00:00:00' }],
  ['since date only', { collection: 'c', since: '2026-10-01' }],
  ['since bad ISO', { collection: 'c', since: '2026-13-45T99:00:00Z' }],
  ['since negative ms', { collection: 'c', since: -1 }],
  ['since fractional ms', { collection: 'c', since: 1.5 }],
  ['since boolean', { collection: 'c', since: true }],
  ['until not after since', { collection: 'c', since: ISO2, until: ISO2 }],
  ['until before since', { collection: 'c', since: Date.parse(ISO2), until: Date.parse(ISO) }],
  ['since with where', { collection: 'c', since: ISO, where: { a: 1 } }],
  ['since with startsWith', { collection: 'c', since: ISO, startsWith: 'a' }],
  ['since with after', { collection: 'c', since: ISO, after: 'a' }],
  ['until with before', { collection: 'c', until: ISO, before: 'a' }],
  ['since with type encrypted', { collection: 'c', since: ISO, type: 'encrypted' }],
  ['index bad name', { index: '1bad' }],
  ['index not string', { index: 5 }],
  ['equals without index', { equals: { a: 1 } }],
  ['equals not object', { index: 'byX', equals: 'a' }],
  ['equals too many fields', { index: 'byX', equals: fields(L.equalsFields.max + 1) }],
  ['equals nested value', { index: 'byX', equals: { a: { b: 1 } } }],
  ['equals non-finite value', { index: 'byX', equals: { a: Infinity } }],
  ['where alone on list', { where: { a: 1 } }],
  ['where with prefix on list', { prefix: 'a', where: { a: 1 } }],
  ['where empty', { collection: 'c', where: {} }],
  ['where too many fields', { collection: 'c', where: fields(L.whereFields.max + 1) }],
  ['where nested value', { collection: 'c', where: { a: [1] } }],
  ['where not object', { collection: 'c', where: 'a=1' }],
  ['where with type encrypted', { collection: 'c', where: { a: 1 }, type: 'encrypted' }],
], list);

tableTest('checkQueryOptions (search)', [
  ['index refused', { index: 'byX', prefix: 'a' }],
  ['equals refused', { equals: {}, prefix: 'a' }],
  ['no filter', {}],
  ['no filter (undefined options)', undefined],
  ['type all is not a filter', { type: 'all' }],
  ['only limit', { limit: L.listLimit.min }],
  ['pattern empty', { pattern: '' }],
  ['pattern too long', { pattern: str(L.prefixPattern.max + 1) }],
  ['prefix with pattern', { prefix: 'a', pattern: 'a*' }],
  ['pattern with collection', { pattern: 'a*', collection: 'c' }],
  ['pattern with since', { pattern: 'a*', collection: 'c', since: ISO }],
  ['where empty', { where: {} }],
  ['where too many fields', { where: fields(L.whereFields.max + 1) }],
  ['where nested', { where: { a: { b: 1 } } }],
  ['where with type encrypted', { where: { a: 1 }, type: 'encrypted' }],
], search);

okTest('checkQueryOptions (list)', [
  ['undefined', undefined],
  ['empty', {}],
  ['limit bounds min', { limit: L.listLimit.min }],
  ['limit bounds max', { limit: L.listLimit.max }],
  ['paging', { prefix: 'a:', cursor: 'abc', includeValues: true, type: 'plaintext' }],
  ['null cursor is absent', { prefix: 'a:', cursor: null }],
  ['undefined values are absent', { prefix: 'a', pattern: undefined, cursor: undefined }],
  ['prefix max length', { prefix: str(L.prefixPattern.max) }],
  ['collection range', { collection: 'c', after: 'a', before: 'b', reverse: true }],
  ['root collection', { collection: '' }],
  ['startsWith', { collection: 'c', startsWith: 'x' }],
  ['window ISO Z and offset', { collection: 'c', since: ISO, until: ISO2, includeValues: true }],
  ['window ms', { collection: 'c', since: Date.parse(ISO), until: Date.parse(ISO2) }],
  ['window fractional seconds', { collection: 'c', since: '2026-10-01T00:00:00.123Z' }],
  ['window type plaintext', { collection: 'c', since: ISO, type: 'plaintext' }],
  ['collection where', { collection: 'c', where: { a: 1, b: 'x', c: null, d: true } }],
  ['collection max bytes', { collection: str(L.ledgerCollectionMaxBytes) }],
  ['where max fields', { collection: 'c', where: fields(L.whereFields.max) }],
  ['index equals', { index: 'byX', equals: fields(L.equalsFields.max) }],
  ['index equals empty', { index: 'byX', equals: {} }],
  ['index without equals', { index: 'byX' }],
  ['index range', { index: 'byX', after: 3, before: null, reverse: false }],
  ['index where', { index: 'byX', where: { a: 1 } }],
], list);

okTest('checkQueryOptions (search)', [
  ['prefix', { prefix: 'a' }],
  ['pattern', { pattern: 'user:*:email', limit: L.listLimit.max }],
  ['where alone', { where: { status: 'open' } }],
  ['type filter', { type: 'encrypted' }],
  ['collection', { collection: 'c' }],
], search);

test('checkQueryOptions defaults to list', () => {
  assertValidation(() => checks.checkQueryOptions({ pattern: 'a*' }));
  assert.doesNotThrow(() => checks.checkQueryOptions({ index: 'byX' }));
});

// ---- transactions ----
const ops = (n) => Array.from({ length: n }, (_, i) => ({ op: 'set', key: `k${i}`, value: i }));
tableTest('checkTransaction', [
  ['not an array', 'x', undefined],
  ['under minOps', ops(L.transaction.minOps - 1), undefined],
  ['over maxOps', ops(L.transaction.maxOps + 1), undefined],
  ['duplicate key', [{ op: 'set', key: 'a', value: 1 }, { op: 'increment', key: 'a' }], undefined],
  ['unknown op', [{ op: 'merge', key: 'a' }], undefined],
  ['op not an object', [null], undefined],
  ['bad key', [{ op: 'set', key: ':a', value: 1 }], undefined],
  ['check version empty', [{ op: 'check', key: 'a', version: '' }], undefined],
  ['check version number', [{ op: 'check', key: 'a', version: 1 }], undefined],
  ['set bad ttl', [{ op: 'set', key: 'a', value: 1, options: { ttl: L.ttl.min - 1 } }], undefined],
  ['delete bad ifVersion', [{ op: 'delete', key: 'a', options: { ifVersion: '' } }], undefined],
  ['increment bad amount', [{ op: 'increment', key: 'a', amount: 0 }], undefined],
  ['commit options not object', ops(1), 'x'],
  ['commit unknown option', ops(1), { mode: 'x' }],
  ['commit bad idempotencyKey', ops(1), { idempotencyKey: 'has space' }],
  ['commit idempotencyKey too long', ops(1), { idempotencyKey: str(patternMax(L.idempotencyKey.pattern) + 1) }],
  ['commit idempotencyKey empty', ops(1), { idempotencyKey: '' }],
], checks.checkTransaction);
test('checkTransaction: expiry-like name on a set op has the hint', () => {
  const o = [{ op: 'set', key: 'a', value: 1, options: { [L.expiryOptionNames[1]]: 1 } }];
  assertValidation(() => checks.checkTransaction(o), { hint: EXPIRY_HINT });
});
test('checkTransaction returns unknown set/delete option names', () => {
  const o = [{ op: 'set', key: 'a', value: 1, options: { mode: 1 } }, { op: 'delete', key: 'b', options: { x: 1 } }];
  assert.deepEqual(checks.checkTransaction(o, undefined), { unknown: ['mode', 'x'] });
});
okTest('checkTransaction', [
  ['minOps', ops(L.transaction.minOps), undefined],
  ['maxOps', ops(L.transaction.maxOps), { idempotencyKey: 'order-42' }],
  ['all kinds', [
    { op: 'check', key: 'a', version: null },
    { op: 'check', key: 'b', version: 'v1' },
    { op: 'set', key: 'c', value: 1, options: { ttl: L.ttl.min } },
    { op: 'delete', key: 'd', options: { ifVersion: 'v' } },
    { op: 'increment', key: 'e', amount: 2 },
    { op: 'increment', key: 'f' },
  ], {}],
], checks.checkTransaction);

// ---- append ----
tableTest('checkAppend', [
  ['collection not string', 5, {}, undefined],
  ['collection empty', '', {}, undefined],
  ['collection too many bytes', str(L.ledgerCollectionMaxBytes + 1), {}, undefined],
  ['value array', 'audit', [], undefined],
  ['value string', 'audit', 'x', undefined],
  ['value null', 'audit', null, undefined],
  ['value class instance', 'audit', new Date(), undefined],
  ['options not object', 'audit', {}, 'x'],
  ['unknown option', 'audit', {}, { ttl: L.ttl.min }],
  ['idempotencyKey bad chars', 'audit', {}, { idempotencyKey: 'a.b' }],
  ['idempotencyKey empty', 'audit', {}, { idempotencyKey: '' }],
  ['idempotencyKey not string', 'audit', {}, { idempotencyKey: 5 }],
], checks.checkAppend);
okTest('checkAppend', [
  ['plain', 'audit', { a: 1 }, undefined],
  ['null prototype', 'audit', Object.create(null), {}],
  ['key', `ai-use:${str(3)}`, { a: 1 }, { idempotencyKey: 'evt-1_A' }],
  ['collection max bytes', str(L.ledgerCollectionMaxBytes), {}, undefined],
], checks.checkAppend);

// ---- ledger name, proof key, index args ----
tableTest('checkLedgerName', [['not string', 5], ['starts with digit', '1a'], ['dash', 'a-b'], ['empty', '']], checks.checkLedgerName);
okTest('checkLedgerName', [['plain', 'aiUse_2']], checks.checkLedgerName);
tableTest('checkProofKey', [['not string', 5], ['empty', ''], ['colon edge', 'audit:']], checks.checkProofKey);
okTest('checkProofKey', [['entry key', 'audit:01ABC-00']], checks.checkProofKey);

tableTest('checkIndexArgs', [
  ['bad name', '1x', { a: 1 }, { min: 1 }],
  ['name not string', null, { a: 1 }, { min: 1 }],
  ['equals missing with min 1', 'byX', undefined, { min: 1 }],
  ['equals empty with min 1', 'byX', {}, { min: 1 }],
  ['equals not object', 'byX', 'a', { min: 0 }],
  ['equals array', 'byX', [1], { min: 0 }],
  ['equals too many', 'byX', fields(L.equalsFields.max + 1), { min: 0 }],
  ['equals nested', 'byX', { a: { b: 1 } }, { min: 0 }],
], checks.checkIndexArgs);
okTest('checkIndexArgs', [
  ['getBy', 'byEmail', { email: 'a@example.com' }, { min: 1 }],
  ['count no equals', 'byStatus', undefined, { min: 0 }],
  ['count empty equals', 'byStatus', {}, { min: 0 }],
  ['max fields', 'byX', fields(L.equalsFields.max), undefined],
], checks.checkIndexArgs);

// ---- where/equals field rules (stores page) ----
// JSON.parse makes "__proto__" an own key; an object literal would set the prototype instead.
const BAD_FIELDS = [
  ['field starts with digit', { '1a': 1 }],
  ['field with dash', { 'a-b': 1 }],
  ['field empty', { '': 1 }],
  ['field over fieldName length', { [str(patternMax(L.fieldName) + 2)]: 1 }],
  ...L.reservedFieldNames.map((name) => [`reserved field ${name}`, JSON.parse(`{${JSON.stringify(name)}:1}`)]),
  ['string value over fieldStringMaxChars', { a: str(L.fieldStringMaxChars + 1) }],
];
tableTest('where field rules (list)', BAD_FIELDS.map(([n, w]) => [n, { collection: 'c', where: w }]), list);
tableTest('where field rules (search)', BAD_FIELDS.map(([n, w]) => [n, { where: w }]), search);
tableTest('equals field rules (list)', BAD_FIELDS.map(([n, e]) => [n, { index: 'byX', equals: e }]), list);
tableTest('equals field rules (checkIndexArgs)', BAD_FIELDS.map(([n, e]) => [n, 'byX', e, { min: 1 }]), checks.checkIndexArgs);
okTest('field rules', [
  ['underscore start, max name length, max string', { where: { [`_${str(patternMax(L.fieldName))}`]: str(L.fieldStringMaxChars) } }],
], search);
