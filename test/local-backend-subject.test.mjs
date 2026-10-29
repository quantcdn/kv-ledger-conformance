// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The ledger subject contract, version 1, in the local backend: declare options, the stored form, reads, the shred
// with its signed receipt, the subject entries, lists by subject, and the index rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalBackend } from '../adapters/reference/backend/index.mjs';
import { ERASED_KEY_MESSAGE } from '../adapters/reference/backend/ledger-append.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { verifySigned } from '../verifier/lib/signed.mjs';

const KVError = createKVErrorClass();
const ORG = 'test-org';
const TOKEN = /^qsub1_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const BASE = { name: 'audit', collection: 'audit:*', chains: 2, retentionDays: 1 };
const PSEUDONYM = { ...BASE, personalFields: ['email'], subjectField: 'userId' };
const WHY = { reason: 'Erasure request 1', authority: 'Records authority 1', requestedBy: 'Privacy officer' };

function make(def = PSEUDONYM) {
  const clock = createVirtualClock();
  const backend = createLocalBackend({ clock, KVError, org: ORG });
  backend.createStore({ id: 's1', format: 2 });
  const declared = def === null ? null : backend.declareLedger('s1', def, { wait: true });
  return { backend, clock, declared };
}

function throwsCode(fn, code, check = () => {}) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof KVError, `KVError, got ${err}`);
    assert.equal(err.code, code, err.message);
    check(err);
    return true;
  });
}

const valueOf = (backend, key) => JSON.parse(backend.get('s1', key).raw);
const storedOf = (backend, key) => JSON.parse(new Map(backend.snapshot().stores[0].items).get(key).raw);

test('declare: subjectMode and subjectCase default to pseudonym and exact, and are checked', () => {
  const { backend, declared } = make();
  assert.equal(declared.definition.subjectMode, 'pseudonym');
  assert.equal(declared.definition.subjectCase, 'exact');
  const clear = backend.declareLedger('s1', { ...BASE, name: 'c', collection: 'c', subjectField: 'u', subjectMode: 'clear',
    subjectCase: 'fold' });
  assert.equal(clear.definition.subjectMode, 'clear');
  assert.equal(clear.definition.subjectCase, 'fold');
  const plain = backend.declareLedger('s1', { ...BASE, name: 'p', collection: 'p' });
  assert.equal(Object.hasOwn(plain.definition, 'subjectMode'), false, 'no subject options without a subjectField');
  throwsCode(() => backend.declareLedger('s1', { ...BASE, name: 'x', collection: 'x', subjectMode: 'clear' }), 'VALIDATION',
    (err) => assert.equal(err.message, 'subjectMode needs a subjectField'));
  throwsCode(() => backend.declareLedger('s1', { ...BASE, name: 'x', collection: 'x', subjectField: 'u', subjectMode: 'open' }),
    'VALIDATION', (err) => assert.equal(err.message, 'subjectMode must be one of: pseudonym, clear'));
  throwsCode(() => backend.declareLedger('s1', { ...BASE, name: 'x', collection: 'x', subjectField: 'u', subjectCase: 'lower' }),
    'VALIDATION', (err) => assert.equal(err.message, 'subjectCase must be one of: exact, fold'));
  throwsCode(() => backend.declareLedger('s1', { ...BASE, name: 'x', collection: 'x', personalFields: ['e'] }),
    'LEDGER_SUBJECT_REQUIRED', (err) => assert.equal(err.message, 'subjectField is required when personalFields is not empty'));
});

test('pseudonym mode: the token is stored, the original value is read, and lists show the token', () => {
  const { backend } = make();
  const r = backend.append('s1', 'audit:a', { userId: ' Alice ', email: 'a@x', n: 1 }, {});
  const stored = storedOf(backend, r.key);
  assert.match(stored.userId, TOKEN);
  assert.deepEqual(Object.keys(stored.$subject), ['$enc', 'iv', 'tag']);
  assert.deepEqual(valueOf(backend, r.key), { userId: ' Alice ', email: 'a@x', n: 1 }, 'the value as appended');
  assert.equal(backend.get('s1', r.key).ledger.subject, 'pseudonym');
  const again = backend.append('s1', 'audit:b', { userId: 'Alice', n: 2 }, {});
  assert.equal(storedOf(backend, again.key).userId, stored.userId, 'one subject, one token');
  const scan = backend.query('s1', { prefix: 'audit', includeValues: true });
  assert.deepEqual(scan.items.map((i) => i.value.userId), [stored.userId, stored.userId]);
  assert.equal(scan.items[0].ledger.subject, 'pseudonym');
});

test('clear mode: the field is kept, the token is in $subjectTag', () => {
  const { backend } = make({ ...PSEUDONYM, subjectMode: 'clear' });
  const r = backend.append('s1', 'audit:a', { userId: 'u1', email: 'a@x' }, {});
  const stored = storedOf(backend, r.key);
  assert.equal(stored.userId, 'u1');
  assert.match(stored.$subjectTag, TOKEN);
  assert.deepEqual(valueOf(backend, r.key), { userId: 'u1', email: 'a@x', $subjectTag: stored.$subjectTag });
  assert.equal(backend.get('s1', r.key).ledger.subject, 'clear');
});

test('append: subject id checks and LEDGER_SUBJECT_REQUIRED', () => {
  const { backend } = make();
  throwsCode(() => backend.append('s1', 'audit:a', { userId: 4.5 }, {}), 'VALIDATION',
    (err) => assert.equal(err.message, 'userId must be a string or a safe integer'));
  throwsCode(() => backend.append('s1', 'audit:a', { userId: ' ' }, {}), 'VALIDATION',
    (err) => assert.equal(err.message, 'userId must be 1 to 256 bytes (UTF-8) of well-formed text without control characters'));
  throwsCode(() => backend.append('s1', 'audit:a', { email: 'a@x' }, {}), 'LEDGER_SUBJECT_REQUIRED',
    (err) => assert.equal(err.message, 'userId is required when a personal field is present'));
  throwsCode(() => backend.append('s1', 'audit:a', { userId: 'u', $subjectTag: 'x' }, {}), 'VALIDATION',
    (err) => assert.equal(err.message, '"$subject" and "$subjectTag" are reserved in ledger entries'));
  assert.equal(backend.append('s1', 'audit:a', { n: 1 }, {}).seq > 0, true, 'no subject field, no personal field');
});

test('shred: shred entries, then { $shredded: true } on reads, a signed receipt and a repeat', () => {
  const { backend } = make();
  const a = backend.append('s1', 'audit:a', { userId: 'u1', email: 'a@x' }, {});
  const b = backend.append('s1', 'audit:b', { userId: 'u1', email: 'b@x' }, {});
  const other = backend.append('s1', 'audit:a', { userId: 'u2', email: 'c@x' }, {});
  const done = backend.shred('s1', 'audit', { subjectId: 'u1', ...WHY });
  assert.match(done.subjectRef, /^[0-9a-f]{32}$/);
  assert.equal(done.refKeyVersion, 1);
  assert.deepEqual(done.entries.map((e) => e.key.split(':')[1].length > 0 && e.key.slice(0, 7)), ['audit:a', 'audit:b']);
  assert.ok(done.entries.every((e) => e.source.type === 'platform' && e.source.principal === 'quant-ledger'));
  assert.deepEqual(valueOf(backend, done.entries[0].key),
    { $event: 'shred', subjectRef: done.subjectRef, ...WHY }, 'the shred entry names the reference, never the id');
  assert.deepEqual(valueOf(backend, a.key), { userId: { $shredded: true }, email: { $shredded: true } });
  assert.deepEqual(valueOf(backend, b.key), { userId: { $shredded: true }, email: { $shredded: true } });
  assert.deepEqual(valueOf(backend, other.key), { userId: 'u2', email: 'c@x' }, 'another subject is kept');
  assert.equal(Date.parse(done.fullyErasedAfter) - Date.parse(done.shreddedAt), 35 * 86_400_000);

  const verdict = verifySigned(done.receipt, backend.publicKey());
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.verdict, 'RECORDED');
  assert.equal(verdict.signed.id, done.shredId);
  assert.equal(verdict.signed.entryCount, 2);
  assert.equal(done.receipt.algorithm, 'ECDSA_SHA_256');

  const repeat = backend.shred('s1', 'audit', { subjectId: 'u1', ...WHY });
  assert.equal(repeat.alreadyShredded, true);
  assert.deepEqual(repeat.entries, []);
  assert.deepEqual(repeat.receipt, done.receipt);
  assert.equal(repeat.shredId, done.shredId);
});

test('shred: errors with the platform texts', () => {
  const { backend } = make();
  backend.declareLedger('s1', { ...BASE, name: 'plain', collection: 'plain' });
  throwsCode(() => backend.shred('s1', 'audit', { subjectId: 'nobody', ...WHY }), 'SUBJECT_NOT_FOUND',
    (err) => assert.equal(err.message, 'This ledger holds no personal data for the data subject'));
  throwsCode(() => backend.shred('s1', 'plain', { subjectId: 'u1', ...WHY }), 'VALIDATION',
    (err) => assert.equal(err.message, 'Ledger plain has no subject field'));
  throwsCode(() => backend.shred('s1', 'nope', { subjectId: 'u1', ...WHY }), 'LEDGER_NOT_FOUND');
  throwsCode(() => backend.shred('s1', 'audit', { subjectId: true, ...WHY }), 'VALIDATION',
    (err) => assert.equal(err.message, 'subjectId is required (a string or a safe integer)'));
  throwsCode(() => backend.shred('s1', 'audit', { subjectId: 'u1', ...WHY, reason: ' ' }), 'VALIDATION',
    (err) => assert.equal(err.message, 'reason is required (1 to 1000 characters)'));
  throwsCode(() => backend.shred('s1', 'audit', { subjectId: 'u1', ...WHY, extra: 1 }), 'VALIDATION',
    (err) => assert.equal(err.message, 'Unknown field extra'));
});

test('after a shred: CONTENTION for 60 seconds, then a new key; the old entries stay shredded', () => {
  const { backend, clock } = make();
  const old = backend.append('s1', 'audit:a', { userId: 'u1', email: 'a@x' }, { idempotencyKey: 'k1' });
  backend.shred('s1', 'audit', { subjectId: 'u1', ...WHY });
  throwsCode(() => backend.append('s1', 'audit:a', { userId: 'u1', email: 'a@x' }, { idempotencyKey: 'k1' }), 'VALIDATION',
    (err) => assert.equal(err.message, ERASED_KEY_MESSAGE));
  throwsCode(() => backend.append('s1', 'audit:a', { userId: 'u1' }, {}), 'CONTENTION',
    (err) => assert.equal(err.message, 'This data subject was shredded moments ago; retry shortly'));
  clock.set(clock.now() + 60_000);
  const fresh = backend.append('s1', 'audit:a', { userId: 'u1', email: 'new@x' }, {});
  assert.deepEqual(valueOf(backend, fresh.key), { userId: 'u1', email: 'new@x' });
  assert.deepEqual(valueOf(backend, old.key).email, { $shredded: true });
  const entries = backend.subjectEntries('s1', 'audit', { subjectId: 'u1' });
  assert.equal(entries.subjectState, 'live');
  assert.deepEqual(entries.entries.map((e) => e.key), [fresh.key], 'only the live generation');
  assert.equal(entries.earlierGenerationsShredded, 1);
});

test('subjectEntries: the live entries, sealed views, pages, and the shredded answer', () => {
  const { backend } = make();
  const keys = [0, 1, 2].map((n) => backend.append('s1', `audit:c${n}`, { userId: 'u1', email: `${n}@x`, n }, {}).key);
  backend.append('s1', 'audit:c0', { userId: 'u2', email: 'other@x' }, {});
  const all = backend.subjectEntries('s1', 'audit', { subjectId: 'u1' });
  assert.deepEqual(all.entries.map((e) => e.key), keys);
  assert.deepEqual(all.entries[0].value, { userId: 'u1', email: '0@x', n: 0 });
  assert.equal(all.entries[0].ledger.subject, 'pseudonym');
  assert.equal(all.complete, true);
  assert.equal(Object.hasOwn(all, 'nextToken'), false);
  const sealed = backend.subjectEntries('s1', 'audit', { subjectId: 'u1', personal: 'sealed', collection: 'audit:c1' });
  assert.deepEqual(sealed.entries.map((e) => [e.key, e.value.email, e.personal]), [[keys[1], '[PERSONAL]', ['email']]]);
  assert.match(sealed.entries[0].value.userId, TOKEN);
  const first = backend.subjectEntries('s1', 'audit', { subjectId: 'u1', limit: 2 });
  const second = backend.subjectEntries('s1', 'audit', { subjectId: 'u1', limit: 2, nextToken: first.nextToken });
  assert.deepEqual([...first.entries, ...second.entries].map((e) => e.key), keys);
  throwsCode(() => backend.subjectEntries('s1', 'audit', { subjectId: 'u1', limit: 0 }), 'VALIDATION',
    (err) => assert.equal(err.message, 'limit must be an integer from 1 to 1000'));
  throwsCode(() => backend.subjectEntries('s1', 'audit', { subjectId: 'u1', collection: 'other' }), 'VALIDATION',
    (err) => assert.equal(err.message, 'collection is not a collection of ledger audit'));
  throwsCode(() => backend.subjectEntries('s1', 'audit', { subjectId: 'u9' }), 'SUBJECT_NOT_FOUND');
  const done = backend.shred('s1', 'audit', { subjectId: 'u1', ...WHY });
  assert.deepEqual(backend.subjectEntries('s1', 'audit', { subjectId: 'u1' }), { ledger: 'audit', subjectState: 'shredded',
    shreds: [done.shredId], entries: [], complete: true, earlierGenerationsShredded: 0 });
});

test('lists by subject: equals on an index and where use the live token', () => {
  const { backend } = make({ ...PSEUDONYM, subjectCase: 'fold' });
  backend.declareIndex('s1', { name: 'byUser', collection: 'audit:a', fields: ['userId'] });
  const r = backend.append('s1', 'audit:a', { userId: 'Alice', email: 'a@x' }, {});
  backend.append('s1', 'audit:a', { userId: 'bob' }, {});
  const listed = backend.query('s1', { index: 'byUser', equals: { userId: ' ALICE ' }, includeValues: true });
  assert.deepEqual(listed.items.map((i) => [i.key, i.value.userId]), [[r.key, 'Alice']]);
  const where = backend.query('s1', { prefix: 'audit', where: { userId: 'alice' } }, { search: true });
  assert.deepEqual(where.items.map((i) => i.key), [r.key]);
  backend.shred('s1', 'audit', { subjectId: 'alice', ...WHY });
  const empty = backend.query('s1', { index: 'byUser', equals: { userId: 'alice' } });
  assert.deepEqual(empty, { items: [], cursor: null, hasMore: false, scannedCount: 0, pageEnd: 'end', indexed: true });
  assert.deepEqual(backend.query('s1', { index: 'byUser', equals: { userId: 4.5 } }).items, [], 'a bad id finds nothing');
});

test('index rules against ledgers, in both orders', () => {
  const { backend } = make();
  throwsCode(() => backend.declareIndex('s1', { name: 'wide', collection: '*:*', fields: ['userId'] }), 'LEDGER_INDEX_KIND',
    (err) => assert.equal(err.message, 'Index wide uses the subject field of ledger audit; its collection must lie within that ledger collection'));
  throwsCode(() => backend.declareIndex('s1', { name: 'sorted', collection: 'audit:a', fields: [], sortBy: 'userId' }),
    'VALIDATION', (err) => assert.equal(err.message, 'An index cannot sort by the subject field of a ledger that covers its collection'));
  throwsCode(() => backend.declareIndex('s1', { name: 'uniq', collection: 'audit:a', fields: ['n'], unique: true }),
    'LEDGER_INDEX_KIND');
  throwsCode(() => backend.declareIndex('s1', { name: 'mail', collection: 'audit:a', fields: ['email'] }),
    'INDEX_FIELD_ENCRYPTED');
  backend.declareIndex('s1', { name: 'counted', collection: 'other', fields: ['n'], count: true });
  throwsCode(() => backend.declareLedger('s1', { ...BASE, name: 'o', collection: 'other' }), 'LEDGER_INDEX_KIND',
    (err) => assert.equal(err.message, 'Index counted is unique or counted; ledger collections take plain indexes only'));
});

test('a ledger of the retired subject format (no subjectMode) refuses appends and decrypted reads', () => {
  const { backend, clock } = make(null);
  backend.declareLedger('s1', PSEUDONYM);
  const r = backend.append('s1', 'audit:a', { userId: 'u1', email: 'a@x' }, {});
  const snap = backend.snapshot();
  const [, entry] = snap.stores[0].ledgers.find(([name]) => name === 'audit');
  delete entry.definition.subjectMode;
  const copy = createLocalBackend({ clock, KVError, org: ORG });
  copy.restore(snap);
  const retired = (err) => assert.equal(err.message, 'This ledger uses a retired subject format; declare a new ledger');
  throwsCode(() => copy.append('s1', 'audit:a', { n: 1 }, {}), 'LEDGER_FORMAT_RETIRED', retired);
  throwsCode(() => copy.get('s1', r.key), 'LEDGER_FORMAT_RETIRED', retired);
  assert.equal(copy.query('s1', { prefix: 'audit', includeValues: true }).items[0].value.email, '[PERSONAL]');
});

test('snapshot and restore keep the subject keys, listings and erasure records', () => {
  const { backend, clock } = make();
  const r = backend.append('s1', 'audit:a', { userId: 'u1', email: 'a@x' }, {});
  const copy = createLocalBackend({ clock, KVError, org: ORG });
  copy.restore(backend.snapshot());
  assert.deepEqual(valueOf(copy, r.key), { userId: 'u1', email: 'a@x' });
  const done = copy.shred('s1', 'audit', { subjectId: 'u1', ...WHY });
  const again = createLocalBackend({ clock, KVError, org: ORG });
  again.restore(copy.snapshot());
  assert.deepEqual(again.shred('s1', 'audit', { subjectId: 'u1', ...WHY }).receipt, done.receipt);
  assert.deepEqual(valueOf(again, r.key).email, { $shredded: true });
});
