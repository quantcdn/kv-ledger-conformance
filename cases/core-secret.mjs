// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/secret: values set with secret: true.
import assert from 'node:assert/strict';
import { ERROR_CODES } from '../lib/error-contract.mjs';
import { allPages, coreCase } from './core-util.mjs';

const SECRET = { needs: ['secretEncryption'] };
const VALUE = { token: 'abc123', n: 7 };

async function readBack({ kv, uniqueKey }) {
  const key = uniqueKey('s');
  await kv.set(key, VALUE, { secret: true });
  assert.deepEqual(await kv.get(key), VALUE);
  assert.deepEqual((await kv.getMany([key]))[0].value, VALUE);
}

async function getEntryEncrypted({ kv, uniqueKey }) {
  const [secret, plain] = [uniqueKey('s'), uniqueKey('p')];
  await kv.set(secret, VALUE, { secret: true });
  await kv.set(plain, VALUE);
  const entry = await kv.getEntry(secret);
  assert.equal(entry.encrypted, true);
  assert.deepEqual(entry.value, VALUE);
  assert.notEqual((await kv.getEntry(plain)).encrypted, true);
}

async function listRedacted({ kv, uniqueKey }) {
  const p = uniqueKey('r');
  await kv.set(`${p}-s`, VALUE, { secret: true });
  await kv.set(`${p}-p`, VALUE);
  const items = (await allPages(kv.list({ prefix: p, includeValues: true }))).flatMap((page) => page.items);
  const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
  assert.equal(byKey[`${p}-s`].encrypted, true);
  assert.equal(byKey[`${p}-s`].value, '[ENCRYPTED]');
  assert.equal(byKey[`${p}-p`].encrypted, false);
  assert.deepEqual(byKey[`${p}-p`].value, VALUE);
}

async function incrementSecret(ctx) {
  const key = ctx.uniqueKey('s');
  await ctx.kv.set(key, 5, { secret: true });
  await ctx.expectKVError(() => ctx.kv.increment(key), { code: Object.keys(ERROR_CODES), retryable: false });
  assert.equal(await ctx.kv.get(key), 5, 'the value did not change');
}

export const coreSecretCases = [
  coreCase('secret/read-back', readBack, SECRET),
  coreCase('secret/getEntry-encrypted', getEntryEncrypted, SECRET),
  coreCase('secret/list-redacted', listRedacted, SECRET),
  coreCase('secret/increment-secret', incrementSecret, SECRET),
];
