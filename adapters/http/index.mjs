// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The public API adapter (spec 10.2): the edge kvStore surface over the public KV v2 HTTP API (public API spec 4.28.0),
// so a third party can run the suite against a Quant platform from their own app. The kvStore is
// lib/edge-surface.mjs over lib/edge-calls.mjs (the same edge-layer checks and allow-list as the reference adapter)
// over ./lib/api-backend.mjs. Admin (./lib/admin.mjs) creates a format 2 store per createStore and deletes the
// stores in dispose. It is also the default admin of the edge-harness adapter.
//
// createAdapter({ clock, env, rate, fetch, pollMs, timeoutMs, warn, log }):
//   env      the environment (default process.env): KVC_API_BASE (the API origin, http or https), KVC_ORG,
//            KVC_PROJECT, KVC_API_TOKEN (sent only as a bearer token; never logged), KVC_RATE (requests per
//            second, default 3)
//   rate     overrides KVC_RATE;  fetch  the fetch to use;  timeoutMs  per request
//   pollMs   the wait between admin polls when the API gives no Retry-After (default 5000)
//   warn     hears unknown set/delete options (the warn phase);  log  hears the dispose summary line
// options.clock (the runner's virtual clock) is not used: the API runs on real time, so the adapter clock is real.
import { buildKvStore } from '../../lib/edge-surface.mjs';
import { createEdgeChecks } from '../../lib/edge-checks.mjs';
import { createEdgeCalls } from '../../lib/edge-calls.mjs';
import { createKVErrorClass } from '../../lib/kv-error.mjs';
import { createRealClock } from '../../lib/clock.mjs';
import { createPublicApi } from './lib/public-api.mjs';
import { createApiBackend } from './lib/api-backend.mjs';
import { createAdmin } from './lib/admin.mjs';

const VARS = { base: 'KVC_API_BASE', org: 'KVC_ORG', project: 'KVC_PROJECT', token: 'KVC_API_TOKEN' };
const RATE_VAR = 'KVC_RATE';
const DEFAULT_RATE = 3;
// The default case timeout: a real platform waits for activations and the request rate cap slows every case.
const DEFAULT_CASE_TIMEOUT_MS = 5 * 60000;

const CAPABILITIES = Object.freeze({
  virtualClock: false,
  eventualIndexLists: true,
  indexBuildStates: true,
  proofTiming: true,
  signedProofs: true,
  search: true,
  // The API is write-only for secret values (single-key reads give "[ENCRYPTED]"), so a read-back cannot pass.
  secretEncryption: false,
  subjectV1: false,
  setClock: false,
  advanceArchive: false,
  injectFault: false,
});

const isSet = (v) => typeof v === 'string' && v.length > 0;
const fail = (message) => {
  throw new Error(`http adapter: ${message}`);
};

function isHttpUrl(text) {
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol);
  } catch {
    return false;
  }
}

function rateOf(options, env) {
  if (options.rate !== undefined) return options.rate;
  if (!isSet(env[RATE_VAR])) return DEFAULT_RATE;
  const rate = Number(env[RATE_VAR]);
  if (!Number.isFinite(rate) || rate <= 0) fail(`${RATE_VAR} must be a positive number of requests per second`);
  return rate;
}

// The configuration from env. Errors name variables, never values.
function readConfig(env, options) {
  const missing = Object.values(VARS).filter((name) => !isSet(env[name]));
  if (missing.length) fail(`missing environment variables: ${missing.join(', ')}`);
  if (!isHttpUrl(env[VARS.base])) fail(`${VARS.base} must be an http or https URL`);
  const config = Object.fromEntries(Object.entries(VARS).map(([field, name]) => [field, env[name]]));
  return { ...config, rate: rateOf(options, env) };
}

export async function createAdapter(options = {}) {
  const config = readConfig(options.env ?? process.env, options);
  const KVError = createKVErrorClass();
  const api = createPublicApi({ ...config, fetch: options.fetch, timeoutMs: options.timeoutMs, KVError });
  const stores = new Map();
  const calls = createEdgeCalls({
    backend: createApiBackend({ api, stores }),
    checks: createEdgeChecks(KVError),
    KVError,
    isAllowed: (id) => stores.has(id),
    warn: options.warn,
  });
  const clock = createRealClock();
  return {
    name: 'http',
    defaultTimeoutMs: DEFAULT_CASE_TIMEOUT_MS,
    kvStore: buildKvStore(calls, KVError),
    shapes: ['global', 'handle'],
    clock,
    capabilities: { ...CAPABILITIES },
    admin: createAdmin({ api, org: config.org, stores, clock, pollMs: options.pollMs, log: options.log }),
  };
}
