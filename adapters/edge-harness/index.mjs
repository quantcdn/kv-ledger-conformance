// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The edge-harness adapter (spec 10.1): runs the suite against a real edge runtime through harness-fn.js, an edge
// function that the owner deploys with the KV stores of the run linked. The kvStore here is a proxy (./proxy.mjs):
// each call goes to the function, which runs it on the runtime's kvStore and answers the outcome as JSON.
// Admin (stores, indexes, ledgers, the proof public key) is outside the edge surface: it goes through the public
// API adapter (adapters/http, spec 10.2), or an admin object given in the options.
//
// createAdapter({ url, token, admin, fetch, env }):
//   url    the harness function URL (env KVC_HARNESS_URL)
//   token  the secret put in place of the placeholder at deploy time (env KVC_HARNESS_TOKEN); never logged
//   admin  an admin object (spec 3); when absent, the public API adapter's admin (env KVC_API_BASE, KVC_ORG,
//          KVC_PROJECT, KVC_API_TOKEN)
//   fetch  the fetch to use (default globalThis.fetch); env  the environment (default process.env)
// The clock is real: advance(ms) waits. There are no control hooks.
import { createKVErrorClass } from '../../lib/kv-error.mjs';
import { createRealClock } from '../../lib/clock.mjs';
import { createClient } from './client.mjs';
import { buildProxyKvStore } from './proxy.mjs';

const HARNESS_VARS = { url: 'KVC_HARNESS_URL', token: 'KVC_HARNESS_TOKEN' };
const API_VARS = ['KVC_API_BASE', 'KVC_ORG', 'KVC_PROJECT', 'KVC_API_TOKEN'];
// The default case timeout: a real platform waits for activations and the request rate cap slows every case.
const DEFAULT_CASE_TIMEOUT_MS = 5 * 60000;

const CAPABILITIES = Object.freeze({
  virtualClock: false,
  eventualIndexLists: true,
  indexBuildStates: true,
  proofTiming: true,
  signedProofs: true,
  search: true,
  secretEncryption: true,
  subjectV1: false,
  setClock: false,
  advanceArchive: false,
  injectFault: false,
});

const isSet = (v) => typeof v === 'string' && v.length > 0;

// The names (never the values) of the variables that are needed and not set.
function missingVariables(options, env) {
  const missing = Object.entries(HARNESS_VARS)
    .filter(([option, name]) => !isSet(options[option]) && !isSet(env[name]))
    .map(([, name]) => name);
  if (options.admin === undefined) missing.push(...API_VARS.filter((name) => !isSet(env[name])));
  return missing;
}

async function defaultAdmin(clock, env) {
  let http;
  try {
    http = await import('../http/index.mjs');
  } catch {
    throw new Error('edge-harness adapter: the public API adapter (adapters/http) is not available; pass options.admin');
  }
  return (await http.createAdapter({ clock, env })).admin;
}

// open(123) must throw synchronously, and handles may be frozen: probe the runtime once, so that the local open()
// repeats what the runtime does.
async function probeOpen(send) {
  const [nonString, valid] = await send([
    { shape: 'global', method: 'open', args: [123] },
    { shape: 'global', method: 'open', args: ['kvc-probe'] },
  ]);
  return { nonString, frozen: valid.ok && valid.value?.frozen === true };
}

export async function createAdapter(options = {}) {
  const env = options.env ?? process.env;
  const missing = missingVariables(options, env);
  if (missing.length) throw new Error(`edge-harness adapter: missing environment variables: ${missing.join(', ')}`);
  const clock = createRealClock();
  const send = createClient({
    url: options.url ?? env[HARNESS_VARS.url],
    token: options.token ?? env[HARNESS_VARS.token],
    fetch: options.fetch,
  });
  const probe = await probeOpen(send);
  const KVError = createKVErrorClass();
  return {
    name: 'edge-harness',
    defaultTimeoutMs: DEFAULT_CASE_TIMEOUT_MS,
    kvStore: buildProxyKvStore(send, KVError, probe),
    shapes: ['global', 'handle'],
    clock,
    capabilities: { ...CAPABILITIES },
    admin: options.admin ?? await defaultAdmin(clock, env),
  };
}
