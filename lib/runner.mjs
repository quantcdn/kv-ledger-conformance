// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// run(options): execute the cases against one adapter and return the report (spec 5).
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases as allCases } from '../cases/index.mjs';
import { createVirtualClock } from './clock.mjs';
import { buildContext, createUniqueKey, pureContext } from './context.mjs';
import { LIMITS } from './limits.mjs';
import { API_SURFACE, SUITE_VERSION, VALIDATED_AGAINST } from './version.mjs';

const DEFAULT_TAGS = ['bytes', 'core', 'ledger'];
const ALL_SHAPES = ['global', 'handle'];
const DEFAULT_TIMEOUT_MS = 30000;
const REASON_MAX = 500;

async function loadAdapterSpec(adapter) {
  if (!adapter) throw new TypeError('run: the adapter option is required');
  if (typeof adapter === 'string') {
    const path = isAbsolute(adapter) ? adapter : resolve(process.cwd(), adapter);
    return { mod: await import(pathToFileURL(path).href), options: {} };
  }
  return { mod: adapter, options: adapter.options || {} };
}

const NO_ADAPTER = Object.freeze({ adapter: null, clock: null });

async function openAdapter(adapterOption) {
  const { mod, options } = await loadAdapterSpec(adapterOption);
  if (typeof mod.createAdapter !== 'function') throw new TypeError('run: the adapter module must export createAdapter');
  const clock = createVirtualClock();
  const adapter = await mod.createAdapter({ clock, ...options });
  return { adapter, clock: adapter.clock || clock };
}

const reasonOf = (err) => {
  const text = String((err && err.message) || (err && err.name) || err);
  return text.split('\n')[0].slice(0, REASON_MAX);
};

// A case that times out is reported as a fail, but it is not cancelled: its promise keeps running in the
// background until it settles. One virtual clock serves the whole run, so a runaway case can still move it.
// The timer is not unref()ed: a case that never settles must keep the loop alive until the timeout fires
// (Node 22 cancels a test whose loop drains first). The finally clears it, so it never outlives the race.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const needsAdapter = (c, settings) => c.adapter !== false && !tagSkip(c, settings);

const startsWithAny = (name, prefixes) => prefixes.some((p) => name.startsWith(p));

function selected(c, settings) {
  if (settings.include.length && !startsWithAny(c.name, settings.include)) return false;
  return !startsWithAny(c.name, settings.exclude);
}

// First reason the case may not run, or null.
function tagSkip(c, settings) {
  const tags = c.tags || [];
  const unselected = tags.find((t) => !settings.tags.includes(t));
  if (unselected) return `tag ${unselected} not selected`;
  return tags.includes('subject-v1') && !settings.enable.includes('subject-v1') ? 'subject-v1 not enabled' : null;
}

function skipReason(c, settings, caps) {
  const early = tagSkip(c, settings);
  if (early) return early;
  const missing = (c.needs || []).find((flag) => !caps[flag]);
  return missing ? `needs ${missing}` : null;
}

function shapesFor(c, settings, adapter) {
  const wanted = c.shapes || ALL_SHAPES;
  const have = (adapter.shapes || []).filter((s) => settings.shapes.includes(s));
  return wanted.filter((s) => have.includes(s));
}

const base = (c) => ({ name: c.name, tags: [...(c.tags || [])] });

// The wait a declaration may take on a real platform, per kind a case lists in `declares`.
const ACTIVATION_MS = Object.freeze({ ledger: LIMITS.ledgerActivationMs, index: LIMITS.indexActivationMs });
const declareWaitMs = (c) => (c.declares || [])
  .reduce((sum, kind) => sum + (ACTIVATION_MS[kind] || 0) + LIMITS.activationMarginMs, 0);

/** The timeout of one case: its own timeoutMs, else the base timeout plus the wait for each declaration. */
export function caseTimeoutMs(c, baseMs) {
  return c.timeoutMs || baseMs + declareWaitMs(c);
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    await fn();
    return { status: 'pass', ms: Date.now() - t0 };
  } catch (err) {
    return { status: 'fail', ms: Date.now() - t0, reason: reasonOf(err) };
  }
}

const guarded = (fn, ms) => withTimeout(Promise.resolve().then(fn), ms);

async function runPure(c, env) {
  const ms = caseTimeoutMs(c, env.timeoutMs);
  return { ...base(c), ...(await timed(() => guarded(() => c.run(pureContext()), ms))) };
}

async function setup(shape, env) {
  const store = await env.adapter.admin.createStore({ format: 2 });
  return buildContext({ adapter: env.adapter, clock: env.clock, store, shape, uniqueKey: env.uniqueKey });
}

// Setup (the store and the context) has its own timeout, and a failure there is an adapter problem: `error`.
// The case timer starts after setup.
async function runShape(c, shape, env) {
  const t0 = Date.now();
  let ctx;
  try {
    ctx = await guarded(() => setup(shape, env), env.timeoutMs);
  } catch (err) {
    return { ...base(c), shape, status: 'error', ms: Date.now() - t0, reason: reasonOf(err) };
  }
  return { ...base(c), shape, ...(await timed(() => guarded(() => c.run(ctx), caseTimeoutMs(c, env.timeoutMs)))) };
}

async function runCase(c, env) {
  const reason = skipReason(c, env.settings, env.caps);
  if (reason) return [{ ...base(c), status: 'skip', ms: 0, reason }];
  if (c.adapter === false) return [await runPure(c, env)];
  const shapes = shapesFor(c, env.settings, env.adapter);
  if (!shapes.length) {
    const names = (c.shapes || ALL_SHAPES).join(', ');
    return [{ ...base(c), status: 'skip', ms: 0, reason: `shape ${names} not supported` }];
  }
  const out = [];
  for (const shape of shapes) out.push(await runShape(c, shape, env));
  return out;
}

const toList = (v, fallback = []) => (v === undefined || v === null ? fallback : [].concat(v));

function settingsFrom(options) {
  return {
    tags: toList(options.tags, DEFAULT_TAGS),
    enable: toList(options.enable),
    include: toList(options.include),
    exclude: toList(options.exclude),
    shapes: toList(options.shapes, ALL_SHAPES),
    timeoutMs: options.timeoutMs,
  };
}

// The run option, else the adapter default, else DEFAULT_TIMEOUT_MS.
const baseTimeoutMs = (settings, adapter) => settings.timeoutMs || (adapter && adapter.defaultTimeoutMs) || DEFAULT_TIMEOUT_MS;

function summarize(results) {
  const summary = { total: results.length, pass: 0, fail: 0, skip: 0, error: 0 };
  for (const r of results) summary[r.status]++;
  return summary;
}

async function runAll(list, env, onResult) {
  const results = [];
  for (const c of list) {
    for (const r of await runCase(c, env)) {
      results.push(r);
      if (onResult) onResult(r);
    }
  }
  return results;
}

async function safeDispose(adapter) {
  try {
    await adapter.admin.dispose();
  } catch {
    // dispose must not hide the results
  }
}

const booleanFlags = (caps) => Object.fromEntries(Object.entries(caps).filter(([, v]) => typeof v === 'boolean'));

async function connect(options, list, settings) {
  if (!list.some((c) => needsAdapter(c, settings))) return NO_ADAPTER;
  if (!options.adapter) throw new TypeError('run: an adapter is required for the selected cases');
  return openAdapter(options.adapter);
}

function buildReport({ adapter, settings, results, startedAt }) {
  return {
    suite: 'kv-conformance',
    version: SUITE_VERSION,
    apiSurface: API_SURFACE,
    validatedAgainst: [...VALIDATED_AGAINST],
    adapter: adapter ? adapter.name : null,
    capabilities: adapter ? booleanFlags(adapter.capabilities || {}) : {},
    shapes: adapter ? [...(adapter.shapes || [])] : [],
    tags: settings.tags,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    summary: summarize(results),
    results,
  };
}

export async function run(options = {}) {
  const settings = settingsFrom(options);
  const startedAt = new Date();
  const list = (options.cases || allCases).filter((c) => selected(c, settings));
  const { adapter, clock } = await connect(options, list, settings);
  const env = { adapter, clock, settings, caps: (adapter && adapter.capabilities) || {}, uniqueKey: createUniqueKey(),
    timeoutMs: baseTimeoutMs(settings, adapter) };
  try {
    const results = await runAll(list, env, options.onResult);
    return buildReport({ adapter, settings, results, startedAt });
  } finally {
    if (adapter) await safeDispose(adapter);
  }
}
