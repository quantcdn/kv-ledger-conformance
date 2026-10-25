// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// subject-v1 (tag subject-v1, needs subjectV1; spec 8): version 1 of the ledger subject pseudonym contract, as the
// edge observes it. Disabled: it runs only with the tag selected and `--enable subject-v1`, against an adapter with
// subjectV1. The server canonicalises the subject (fixtures/subject-v1-vectors.json); a client never does, so these
// cases check only what the edge sees. Each case states the contract version (subjectContract: 1).
import assert from 'node:assert/strict';
import { allKeys, assertSameSet, eventually, expectValidation } from './core-util.mjs';
import { COLLECTION, declare } from './ledger-util.mjs';

const PSEUDONYM = { subjectField: 'userId', subjectMode: 'pseudonym' };
const BY_USER = { name: 'byUser', collection: COLLECTION, fields: ['userId'] };

function subjectCase(name, run, declares = ['ledger']) {
  return { name: `subject-v1/${name}`, tags: ['subject-v1'], needs: ['subjectV1'], subjectContract: 1, declares, run };
}

const LEDGER_AND_INDEX = ['ledger', 'index'];

async function declarePseudonym(ctx) {
  const declared = await declare(ctx, PSEUDONYM);
  assert.equal(declared.definition.subjectField, 'userId');
  assert.equal(declared.definition.subjectMode, 'pseudonym');
  assert.equal(declared.definition.subjectCase, 'exact', 'subjectCase defaults to exact');
}

async function readBack(ctx) {
  await declare(ctx, PSEUDONYM);
  const receipt = await ctx.kv.append(COLLECTION, { userId: 'Alice', action: 'x' });
  const entry = await ctx.kv.getEntry(receipt.key);
  assert.deepEqual(entry.value, { userId: 'Alice', action: 'x' }, 'the subject reads back as appended');
  assert.equal(entry.ledger.subject, 'pseudonym');
  assert.deepEqual(await ctx.kv.get(receipt.key), { userId: 'Alice', action: 'x' });
}

async function reserved(ctx) {
  await declare(ctx, PSEUDONYM);
  await expectValidation(ctx, [
    () => ctx.kv.append(COLLECTION, { userId: 'a', $subject: 'x' }),
    () => ctx.kv.append(COLLECTION, { userId: 'a', $subjectTag: 'x' }),
  ], 'reserved');
}

async function badType(ctx) {
  await declare(ctx, PSEUDONYM);
  await expectValidation(ctx, [
    () => ctx.kv.append(COLLECTION, { userId: 4.5, action: 'x' }),
    () => ctx.kv.append(COLLECTION, { userId: '\uD800', action: 'x' }),
  ], 'bad-type');
}

/** Appends one entry per subject value; a plain index on userId lists them all with `equals`. */
async function assertOneSubject(ctx, values, equals) {
  await ctx.admin.declareIndex(ctx.storeId, BY_USER, { wait: true });
  const keys = [];
  for (const userId of values) keys.push((await ctx.kv.append(COLLECTION, { userId, action: 'x' })).key);
  await eventually(ctx, async () => {
    const listed = await allKeys(ctx.kv.list({ index: BY_USER.name, equals: { userId: equals } }));
    assertSameSet(listed, keys, `one subject: ${JSON.stringify(values)}`);
  });
}

async function sameSubject(ctx) {
  await declare(ctx, PSEUDONYM);
  await assertOneSubject(ctx, [42, '42', ' 42 '], 42);
}

async function fold(ctx) {
  await declare(ctx, { ...PSEUDONYM, subjectCase: 'fold' });
  await assertOneSubject(ctx, ['Alice@X', 'alice@x'], 'alice@x');
}

export const subjectV1Cases = [
  subjectCase('declare-pseudonym', declarePseudonym),
  subjectCase('read-back', readBack),
  subjectCase('reserved', reserved),
  subjectCase('bad-type', badType),
  subjectCase('same-subject', sameSubject, LEDGER_AND_INDEX),
  subjectCase('fold', fold, LEDGER_AND_INDEX),
];
