// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalBackend } from '../adapters/reference/backend/index.mjs';
import { openField, sealField } from '../adapters/reference/backend/ledger-seal.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { LIMITS } from '../lib/limits.mjs';
import { entryHash, genesisHash, instanceName, definitionHash } from '../lib/ledger-bytes.mjs';
import { loadVectors } from '../lib/context.mjs';

const KVError = createKVErrorClass();
const ORG = 'test-org';
const DEF = { name: 'audit', collection: 'audit', chains: 1, retentionDays: 1 };
const PERSONAL = { ...DEF, personalFields: ['name'], subjectField: 'userId' };

function make(def = DEF, { wait = true, seed } = {}) {
  const clock = createVirtualClock();
  const backend = createLocalBackend({ clock, KVError, org: ORG, seed });
  backend.createStore({ id: 's1', format: 2 });
  const declared = def === null ? null : backend.declareLedger('s1', def, { wait });
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

const recordOf = (backend, key) => new Map(backend.snapshot().stores[0].items).get(key);

test('the personal vector: sealField reproduces the envelope, openField reverses it', () => {
  const { personal } = loadVectors();
  const key = Buffer.from(personal.keyHex, 'hex');
  const iv = Buffer.from(personal.ivBase64, 'base64');
  const envelope = sealField({ key, iv, aad: personal.aad, plaintext: personal.plaintextJson });
  assert.deepEqual(envelope, personal.envelope);
  assert.deepEqual(Object.keys(envelope), ['$enc', 'iv', 'tag']);
  assert.equal(openField({ key, aad: personal.aad, envelope }), personal.plaintextJson);
  assert.throws(() => openField({ key, aad: `${personal.aad}x`, envelope }), 'another aad does not open');
});

test('declareLedger completes the definition and hashes it', () => {
  const { declared, clock } = make();
  const { definition } = declared;
  assert.equal(definition.v, 1);
  assert.equal(definition.lockMode, 'governance');
  assert.deepEqual(definition.personalFields, []);
  assert.deepEqual(definition.anchor, { type: 'none' });
  assert.equal(definition.createdAt, new Date(clock.now()).toISOString());
  assert.equal(declared.definitionHash, definitionHash(definition));
  assert.equal(declared.state, 'ACTIVE');
});

test('declareLedger refuses bad definitions', () => {
  const { backend } = make(null);
  const bad = [{ ...DEF, name: '1x' }, { ...DEF, chains: 0 }, { ...DEF, chains: LIMITS.ledgerChains.max + 1 },
    { ...DEF, retentionDays: 0 }, { ...DEF, lockMode: 'x' }, { ...DEF, extra: 1 }, { ...DEF, collection: 'a::b' },
    { ...DEF, personalFields: ['at'], subjectField: 'u' }, { ...PERSONAL, subjectField: 'name' }];
  for (const def of bad) throwsCode(() => backend.declareLedger('s1', def, { wait: true }), 'VALIDATION');
  throwsCode(() => backend.declareLedger('s1', { ...DEF, personalFields: ['n'] }, { wait: true }), 'LEDGER_SUBJECT_REQUIRED');
  backend.put('s1', 'full:x', '1');
  throwsCode(() => backend.declareLedger('s1', { ...DEF, collection: 'full' }, { wait: true }),
    'LEDGER_COLLECTION_NOT_EMPTY', (err) => assert.equal(err.reason, 'not_empty'));
});

test('a PENDING ledger refuses appends until activeAfter', () => {
  const { backend, clock, declared } = make(DEF, { wait: false });
  assert.equal(declared.state, 'PENDING');
  assert.equal(declared.activeAfter, new Date(clock.now() + LIMITS.ledgerActivationMs).toISOString());
  throwsCode(() => backend.append('s1', 'audit', { a: 1 }, {}), 'LEDGER_NOT_READY', (err) => {
    assert.equal(err.retryable, true);
    assert.equal(err.status, 409);
    assert.equal(err.activeAfter, declared.activeAfter);
  });
  clock.set(clock.now() + LIMITS.ledgerActivationMs);
  assert.equal(backend.append('s1', 'audit', { a: 1 }, {}).seq, 1);
});

test('append: receipt, stored envelope and entry hash', () => {
  const { backend, declared } = make();
  const r = backend.append('s1', 'audit', { action: 'login' }, {});
  const source = { type: 'edge', principal: `${ORG}/local/reference` };
  assert.deepEqual(r.source, source);
  assert.match(r.id, /^[0-9A-HJKMNP-TV-Z]{26}-00$/);
  assert.equal(r.key, `audit:${r.id}`);
  const stored = JSON.stringify({ type: 'plaintext', value: { action: 'login' }, source });
  const instance = instanceName(ORG, 's1', 'audit', '00');
  assert.equal(r.prevHash, genesisHash(instance, declared.definitionHash));
  assert.equal(r.hash, entryHash({ prevHash: r.prevHash, instance, seq: 1, id: r.id, at: r.at, stored }));
  assert.equal(recordOf(backend, r.key).stored, stored);
});

test('ids increase within a shard when the clock runs backwards', () => {
  const { backend, clock } = make();
  const a = backend.append('s1', 'audit', { n: 1 }, {});
  backend.setClock(clock.now() - 5000);
  const b = backend.append('s1', 'audit', { n: 2 }, {});
  assert.ok(b.id > a.id, 'id increases');
  assert.ok(b.at >= a.at, 'at does not go back');
});

test('idempotency: replay, conflict and the replay window', () => {
  const { backend, clock } = make({ ...DEF, collection: 'audit:*' });
  const first = backend.append('s1', 'audit:a', { n: 1 }, { idempotencyKey: 'k1' });
  assert.deepEqual(backend.append('s1', 'audit:a', { n: 1 }, { idempotencyKey: 'k1' }), { ...first, replayed: true });
  throwsCode(() => backend.append('s1', 'audit:a', { n: 2 }, { idempotencyKey: 'k1' }), 'VALIDATION');
  throwsCode(() => backend.append('s1', 'audit:b', { n: 1 }, { idempotencyKey: 'k1' }), 'VALIDATION');
  clock.set(clock.now() + LIMITS.idempotencyKey.replayWindowMs + 1);
  assert.equal(backend.append('s1', 'audit:a', { n: 1 }, { idempotencyKey: 'k1' }).seq, 2);
});

test('append refuses reserved fields and over-size values', () => {
  const { backend } = make();
  for (const value of [{ at: 1 }, { $event: 'x' }, { f: { $enc: 'x' } }, { f: { $shredded: true } }, { $subject: 'x' }]) {
    throwsCode(() => backend.append('s1', 'audit', value, {}), 'VALIDATION');
  }
  throwsCode(() => backend.append('s1', 'audit', { pad: 'x'.repeat(LIMITS.ledgerValueMaxBytes) }, {}), 'LIMIT_EXCEEDED',
    (err) => assert.equal(err.status, 400));
  throwsCode(() => backend.append('s1', 'other', { a: 1 }, {}), 'LEDGER_NOT_FOUND');
});

test('personal fields are sealed per subject and opened on reads', () => {
  const { backend } = make(PERSONAL);
  const r = backend.append('s1', 'audit', { userId: 'u1', name: 'A. Person', note: 'n' }, {});
  const stored = JSON.parse(recordOf(backend, r.key).stored);
  assert.deepEqual(Object.keys(stored.value.name), ['$enc', 'iv', 'tag']);
  assert.match(stored.value.userId, /^qsub1_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'pseudonym mode stores the token');
  assert.deepEqual(Object.keys(stored.value.$subject), ['$enc', 'iv', 'tag'], 'and the subject sealed in $subject');
  assert.deepEqual(JSON.parse(backend.get('s1', r.key).raw), { userId: 'u1', name: 'A. Person', note: 'n' });
  const page = backend.query('s1', { collection: 'audit', includeValues: true });
  assert.equal(page.items[0].value.name, 'A. Person');
  assert.deepEqual(page.items[0].personal, ['name']);
  const scan = backend.query('s1', { prefix: 'audit', includeValues: true });
  assert.equal(scan.items[0].value.name, '[PERSONAL]', 'a prefix list does not decrypt');
  assert.equal(scan.items[0].value.userId, stored.value.userId, 'a prefix list shows the token');
  assert.equal(Object.hasOwn(scan.items[0].value, '$subject'), false);
  throwsCode(() => backend.append('s1', 'audit', { name: 'B' }, {}), 'LEDGER_SUBJECT_REQUIRED');
  assert.equal(backend.append('s1', 'audit', { note: 'no personal field' }, {}).seq, 2);
});

test('ledger entries are immutable', () => {
  const { backend } = make();
  const r = backend.append('s1', 'audit', { a: 1 }, {});
  throwsCode(() => backend.put('s1', r.key, '2'), 'LEDGER_IMMUTABLE', (err) => assert.equal(err.status, 400));
  throwsCode(() => backend.remove('s1', r.key), 'LEDGER_IMMUTABLE');
  throwsCode(() => backend.increment('s1', r.key, 1), 'LEDGER_IMMUTABLE');
  throwsCode(() => backend.transact('s1', [{ op: 'set', key: r.key, raw: '1', options: {} }]), 'LEDGER_IMMUTABLE');
});

test('injectFault on append: before writes nothing, after-write writes and loses the response', () => {
  const { backend } = make();
  backend.injectFault({ op: 'append', when: 'before' });
  throwsCode(() => backend.append('s1', 'audit', { a: 1 }, { idempotencyKey: 'k' }), 'UNAVAILABLE');
  assert.equal(backend.ledgerStatus('s1', 'audit').headSeq, 0);
  backend.injectFault({ op: 'append', when: 'after-write' });
  throwsCode(() => backend.append('s1', 'audit', { a: 1 }, { idempotencyKey: 'k' }), 'UNAVAILABLE', (err) => {
    assert.equal(err.retryable, true);
    assert.equal(err.idempotencyKey, 'k');
  });
  assert.equal(backend.append('s1', 'audit', { a: 1 }, { idempotencyKey: 'k' }).replayed, true);
  backend.injectFault({ op: 'append', when: 'after-write' });
  throwsCode(() => backend.append('s1', 'audit', { a: 2 }, { idempotencyKey: 'q_' + '0'.repeat(32), auto: true }),
    'UNAVAILABLE', (err) => assert.equal(err.retryable, false));
  assert.equal(backend.ledgerStatus('s1', 'audit').headSeq, 2);
});

test('shard choice is seeded: one seed gives one shard sequence', () => {
  const shards = (seed) => {
    const { backend } = make({ ...DEF, chains: 8 }, { seed });
    return Array.from({ length: 10 }, (_, i) => backend.append('s1', 'audit', { i }, {}).shard).join(',');
  };
  assert.equal(shards(7), shards(7));
  assert.notEqual(shards(1), shards(2));
});

test('drop, status, proof and list order', () => {
  const { backend } = make({ ...DEF, chains: 4 });
  const receipts = Array.from({ length: 8 }, (_, i) => backend.append('s1', 'audit', { i }, {}));
  const st = backend.ledgerStatus('s1', 'audit');
  assert.equal(st.headSeq, 8);
  assert.equal(st.archivedSeq, 0);
  assert.equal(st.hasMoreShards, false);
  assert.deepEqual(backend.ledgerProof('s1', 'audit', receipts[0].key), { status: 'pending' });
  const keys = backend.query('s1', { collection: 'audit', limit: 100 }).items.map((item) => item.key);
  const order = [...receipts].sort((a, b) => (a.at - b.at) || a.shard.localeCompare(b.shard) || (a.id < b.id ? -1 : 1));
  assert.deepEqual(keys, order.map((r) => r.key));
  throwsCode(() => backend.dropLedger('s1', 'audit'), 'LEDGER_RETAINED');
  const empty = make();
  empty.backend.dropLedger('s1', 'audit');
  assert.equal(empty.backend.ledgerStatus('s1', 'audit').state, 'DROPPED');
  throwsCode(() => empty.backend.append('s1', 'audit', { a: 1 }, {}), 'LEDGER_DROPPED',
    (err) => assert.equal(err.ledger, 'audit'));
});

test('snapshot and restore keep ledgers, chains and subject keys', () => {
  const { backend, clock } = make(PERSONAL);
  const r = backend.append('s1', 'audit', { userId: 'u1', name: 'A' }, {});
  const copy = createLocalBackend({ clock, KVError, org: ORG });
  copy.restore(backend.snapshot());
  assert.equal(JSON.parse(copy.get('s1', r.key).raw).name, 'A');
  assert.equal(copy.append('s1', 'audit', { userId: 'u1' }, {}).prevHash, r.hash);
});
