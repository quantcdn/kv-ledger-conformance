// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/iteration: for await, pages(), items(), the page cap and resume.
import assert from 'node:assert/strict';
import { assertSameSet, coreCase, expectValidation, fill, names, sortBytes } from './core-util.mjs';

const COUNT = 60;
const PAGE = 7;

// 60 keys in one collection (id order is a stable order to check).
async function seed({ kv, uniqueKey }) {
  const collection = uniqueKey('it');
  const keys = names(`${collection}:`, COUNT);
  await fill(kv, keys);
  return { collection, keys: sortBytes(keys) };
}

// for await over the query itself, with the documented resume loop for the default page cap.
async function forAwait(ctx) {
  const { collection, keys } = await seed(ctx);
  const seen = [];
  let cursor;
  for (let round = 0; round < ctx.limits.maxPages.max; round += 1) {
    try {
      for await (const item of ctx.kv.list({ collection, limit: PAGE, cursor })) seen.push(item.key);
      break;
    } catch (err) {
      if (!(err instanceof ctx.kvStore.KVError) || err.code !== 'LIMIT_EXCEEDED') throw err;
      cursor = err.cursor;
    }
  }
  assert.deepEqual(seen, keys, 'every item, in order');
}

async function pages(ctx) {
  const { collection } = await seed(ctx);
  let count = 0;
  let items = 0;
  for await (const page of ctx.kv.list({ collection, limit: PAGE }).pages({ maxPages: ctx.limits.maxPages.max })) {
    count += 1;
    items += page.items.length;
  }
  assert.ok(count >= Math.ceil(COUNT / PAGE), `at least ${Math.ceil(COUNT / PAGE)} pages, got ${count}`);
  assert.equal(items, COUNT);
}

const CAP = 2;

// Iterates with maxPages CAP; returns { seen, err }.
async function capped(ctx, collection) {
  const seen = [];
  const err = await ctx.expectKVError(async () => {
    for await (const item of ctx.kv.list({ collection, limit: PAGE }).items({ maxPages: CAP })) seen.push(item.key);
  }, { code: 'LIMIT_EXCEEDED', retryable: false, details: { cursor: 'string' } });
  return { seen, err };
}

// Short pages (a scan budget) can hold fewer than PAGE items; full pages hold exactly PAGE.
function assertCapCount(ctx, seen) {
  assert.ok(seen.length <= CAP * PAGE && seen.length > 0, `at most ${CAP * PAGE} items before the cap, got ${seen.length}`);
  if (!ctx.caps.shortPages) assert.equal(seen.length, CAP * PAGE);
}

async function cap(ctx) {
  const { collection } = await seed(ctx);
  const { seen } = await capped(ctx, collection);
  assertCapCount(ctx, seen);
}

async function resume(ctx) {
  const { collection, keys } = await seed(ctx);
  const { seen, err } = await capped(ctx, collection);
  const rest = [];
  const query = ctx.kv.list({ collection, limit: PAGE, cursor: err.cursor });
  for await (const item of query.items({ maxPages: ctx.limits.maxPages.max })) rest.push(item.key);
  assert.equal(rest.length, COUNT - seen.length, `${COUNT - seen.length} more items`);
  assertSameSet([...seen, ...rest], keys, 'no repeats, nothing missing');
}

async function defaultCap(ctx) {
  const { collection } = await seed(ctx);
  const limit = Math.floor(COUNT / (ctx.limits.maxPages.default + 2));
  await ctx.expectKVError(async () => {
    for await (const item of ctx.kv.list({ collection, limit })) assert.ok(item.key);
  }, { code: 'LIMIT_EXCEEDED', retryable: false, details: { cursor: 'string' } });
}

async function maxPagesBounds(ctx) {
  const { min, max } = ctx.limits.maxPages;
  const query = () => ctx.kv.list({ limit: 1 });
  // The refusal may come from items()/pages() itself or from the first step: both are inside the closure.
  const step = (method, options) => async () => {
    const cursor = query()[method](options);
    await cursor[Symbol.asyncIterator]().next();
  };
  const bad = [{ maxPages: min - 1 }, { maxPages: max + 1 }, { maxPages: min + 0.5 }, { bogus: 1 }];
  await expectValidation(ctx, bad.flatMap((options) => [step('items', options), step('pages', options)]), 'maxPages');
}

// shortPages: the page scan budget is at most limits.shortPagesBudgetMax rows. With three times that many items and
// matches only at the first and the last key, a page between them is empty with hasMore true; iteration goes on.
async function shortPages({ kv, uniqueKey, limits }) {
  const count = 3 * limits.shortPagesBudgetMax;
  const keys = names(`${uniqueKey('sp')}-`, count);
  const sorted = sortBytes(keys);
  const match = [sorted[0], sorted[count - 1]];
  await fill(kv, keys, (key) => ({ hit: match.includes(key) }));
  let empty = 0;
  const found = [];
  for await (const page of kv.search({ where: { hit: true }, limit: 10 }).pages({ maxPages: limits.maxPages.max })) {
    if (page.items.length === 0 && page.hasMore) empty += 1;
    found.push(...page.items.map((i) => i.key));
  }
  assert.ok(empty > 0, 'at least one empty page with hasMore true');
  assertSameSet(found, match, 'every match reached');
}

export const coreIterationCases = [
  coreCase('iteration/for-await', forAwait),
  coreCase('iteration/pages', pages),
  coreCase('iteration/cap', cap),
  coreCase('iteration/resume', resume),
  coreCase('iteration/default-cap', defaultCap),
  coreCase('iteration/max-pages-bounds', maxPagesBounds),
  coreCase('iteration/short-pages', shortPages, { needs: ['shortPages', 'search'] }),
];
