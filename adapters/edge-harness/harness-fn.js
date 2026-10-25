// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
//
// Conformance harness edge function (body form: the runtime wraps it as
// `async function (event, kvStore, ...) { 'use strict'; <this body> }`).
//
// Deploy it to a throwaway project with the KV stores of the run linked, after you replace the token placeholder
// (the value of EXPECTED_TOKEN below) with a random secret of at least 32 characters.
// Until you do, every request answers 503.
// The suite's edge-harness adapter (adapters/edge-harness/index.mjs) sends the kvStore calls of each case here and
// rebuilds the outcomes. Only standard web globals (Request, Response, JSON, TextEncoder) and kvStore are used.
//
// Request: POST, JSON body { token, calls: [call, ...] }, 1 to MAX_CALLS calls, run one after the other.
//   call: { shape: 'global' | 'handle', storeId, method, args?, undef? }
//     global: kvStore[method](storeId, ...args); handle: kvStore.open(storeId)[method](...args)
//     undef: indexes of args that are undefined (JSON has no undefined; they travel as null)
//   list/search add iterate?: { mode: 'page' | 'items' | 'pages' | 'asyncIterator', args?, undef? }: the function
//     runs the whole iteration and answers { collected, error? } (error: the error that ended it, with its cursor)
//   atomic: { method: 'atomic', ops: [{ op, args?, undef? }], commit: [{ args?, undef? }, ...] }: builds once,
//     commits once per commit entry (at most 2), answers { outcomes: [result, ...] }
//   verifyChain: global kvStore.verifyChain(...args) (storeId unused); handle: kvStore.open(storeId).verifyChain(...)
//   open (global only): kvStore.open(...args), answers { storeId, frozen } or the error with sync true (thrown
//     synchronously) or false (a rejected promise)
// Answer: 200 { results: [result, ...] }, result { ok: true, value? } | { ok: false, sync?, error }.
//   error: { name, code, status, retryable, instanceOfKVError, message, fields } (fields: own JSON-safe properties)
//   A result that JSON cannot carry becomes { ok: false, error: { name: 'HarnessEncodeError' } }; an error field
//   that is not a scalar (string, number, boolean, null) travels as { nonScalar: true }.
// Refusals (no kvStore call is made): 405 not POST, 503 placeholder or short token (under MIN_TOKEN characters),
// 413 body over MAX_BODY characters, 403 missing or wrong token, 400 bad call.

const EXPECTED_TOKEN = '__HARNESS_TOKEN__';
// Built from parts so that a replace-all of the placeholder at deploy time does not change it.
const PLACEHOLDER = ['__HARNESS', 'TOKEN__'].join('_');
const MAX_CALLS = 50;
const MIN_TOKEN = 32;
const MAX_BODY = 1024 * 1024;
const MESSAGE_MAX = 1000;

const BASE = ['get', 'set', 'delete', 'getEntry', 'getMany', 'getBy', 'count', 'increment', 'list', 'search',
  'append', 'ledgerStatus', 'ledgerProof', 'atomic', 'verifyChain'];
const SHAPES = ['global', 'handle'];
const ALLOWED = { global: [...BASE, 'open'], handle: BASE };
const QUERY = ['list', 'search'];
const MODES = ['page', 'items', 'pages', 'asyncIterator'];
const OPS = ['check', 'set', 'delete', 'increment'];
const SKIP_FIELDS = ['name', 'message', 'stack', 'code', 'status', 'retryable'];
const ENCODE_FAILED = Object.freeze({ ok: false, error: { name: 'HarnessEncodeError' } });

function answer(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Constant-time comparison over the UTF-8 bytes: the time depends only on the lengths.
function sameToken(given, expected) {
  if (typeof given !== 'string') return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) diff |= (a[i] | 0) ^ (b[i] | 0);
  return diff === 0;
}

// ---- request checks: [rule that must hold, problem] ----

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIndexList = (v) => v === undefined || (Array.isArray(v) && v.every((i) => Number.isInteger(i) && i >= 0));
const argsOk = (o) => isObject(o) && (o.args === undefined || Array.isArray(o.args)) && isIndexList(o.undef);

const iterateOk = (c) => c.iterate === undefined
  || (QUERY.includes(c.method) && argsOk(c.iterate) && MODES.includes(c.iterate.mode));
const opsOk = (c) => Array.isArray(c.ops) && c.ops.every((op) => argsOk(op) && OPS.includes(op.op));
const commitOk = (c) => Array.isArray(c.commit) && c.commit.length >= 1 && c.commit.length <= 2 && c.commit.every(argsOk);
const atomicOk = (c) => c.method !== 'atomic' || (opsOk(c) && commitOk(c));

const CALL_RULES = [
  [(c) => argsOk(c), 'a call must be an object with args an array and undef a list of indexes'],
  [(c) => SHAPES.includes(c.shape), 'shape must be global or handle'],
  [(c) => ALLOWED[c.shape].includes(c.method), 'method is not a kvStore method for this shape'],
  [iterateOk, 'iterate needs list or search and a known mode'],
  [atomicOk, 'atomic needs ops (check, set, delete, increment) and 1 or 2 commit entries'],
];

function callProblem(call, i) {
  const broken = CALL_RULES.find(([holds]) => !holds(call));
  return broken === undefined ? null : `calls[${i}]: ${broken[1]}`;
}

function requestProblem(body) {
  if (!Array.isArray(body.calls) || body.calls.length < 1) return 'calls must be a non-empty array';
  if (body.calls.length > MAX_CALLS) return `at most ${MAX_CALLS} calls per request`;
  for (const [i, call] of body.calls.entries()) {
    const problem = callProblem(call, i);
    if (problem !== null) return problem;
  }
  return null;
}

// ---- outcomes ----

const isKVError = (e) => typeof kvStore.KVError === 'function' && e instanceof kvStore.KVError;
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const fieldValue = (v) => (isScalar(v) ? v : { nonScalar: true });

function fieldsOf(e) {
  const fields = {};
  for (const name of Object.keys(e)) {
    if (!SKIP_FIELDS.includes(name) && e[name] !== undefined) fields[name] = fieldValue(e[name]);
  }
  return fields;
}

function errorInfo(e) {
  const isObj = e !== null && typeof e === 'object';
  const info = {
    name: isObj ? e.name : undefined,
    instanceOfKVError: isKVError(e),
    message: String((isObj ? e.message : e) ?? '').slice(0, MESSAGE_MAX),
    fields: isObj ? fieldsOf(e) : {},
  };
  for (const name of ['code', 'status', 'retryable']) if (isObj && isScalar(e[name])) info[name] = e[name];
  return info;
}

const failed = (e, sync) => ({ ok: false, sync, error: errorInfo(e) });

// Runs fn; a synchronous throw and a rejection both become { ok: false }, with sync telling them apart.
async function attempt(fn) {
  let pending;
  try {
    pending = fn();
  } catch (e) {
    return failed(e, true);
  }
  try {
    return { ok: true, value: await pending };
  } catch (e) {
    return failed(e, false);
  }
}

function argsOf(o) {
  const args = [...(o.args || [])];
  for (const i of o.undef || []) args[i] = undefined;
  return args;
}

// The function that calls one method in the call's shape.
function invoker(call) {
  if (call.shape === 'handle') return (method, args) => kvStore.open(call.storeId)[method](...args);
  return (method, args) => kvStore[method](call.storeId, ...args);
}

// ---- call kinds ----

const START = {
  items: (q, args) => q.items(...args),
  pages: (q, args) => q.pages(...args),
  asyncIterator: (q) => q[Symbol.asyncIterator](),
};

async function iterate(call) {
  const collected = [];
  const run = async () => {
    const iterator = START[call.iterate.mode](invoker(call)(call.method, argsOf(call)), argsOf(call.iterate));
    for (let step = await iterator.next(); !step.done; step = await iterator.next()) collected.push(step.value);
  };
  const outcome = await attempt(run);
  return { ok: true, value: outcome.ok ? { collected } : { collected, sync: outcome.sync, error: outcome.error } };
}

function buildAtomic(call) {
  const builder = invoker(call)('atomic', []);
  for (const op of call.ops) builder[op.op](...argsOf(op));
  return builder;
}

async function atomic(call) {
  const built = await attempt(() => buildAtomic(call));
  const outcomes = [];
  for (const entry of call.commit) {
    // A failed build or a failed commit stands for every later commit: a commit runs only after a success.
    const blocked = built.ok ? outcomes.find((o) => !o.ok) : built;
    outcomes.push(blocked ?? await attempt(() => built.value.commit(...argsOf(entry))));
  }
  return { ok: true, value: { outcomes } };
}

function describeHandle(handle) {
  return { storeId: handle?.storeId, frozen: Object.isFrozen(handle) };
}

async function open(call) {
  const outcome = await attempt(() => kvStore.open(...argsOf(call)));
  return outcome.ok ? { ok: true, value: describeHandle(outcome.value) } : outcome;
}

function verifyChain(call) {
  if (call.shape === 'handle') return attempt(() => kvStore.open(call.storeId).verifyChain(...argsOf(call)));
  return attempt(() => kvStore.verifyChain(...argsOf(call)));
}

const plain = (call) => attempt(() => invoker(call)(call.method, argsOf(call)));
const query = (call) => (call.iterate === undefined || call.iterate.mode === 'page' ? plain(call) : iterate(call));

const KINDS = { atomic, open, verifyChain, list: query, search: query };

// The result itself when JSON can carry it, else ENCODE_FAILED.
function encodable(result) {
  try {
    JSON.stringify(result);
    return result;
  } catch {
    return ENCODE_FAILED;
  }
}

async function runCalls(calls) {
  const results = [];
  for (const call of calls) results.push(encodable(await (KINDS[call.method] || plain)(call)));
  return results;
}

// ---- the request ----

function parse(text) {
  try {
    const body = JSON.parse(text);
    return isObject(body) ? body : {};
  } catch {
    return {};
  }
}

const configured = () => EXPECTED_TOKEN !== PLACEHOLDER && EXPECTED_TOKEN.length >= MIN_TOKEN;

async function handle(request) {
  if (request.method !== 'POST') return answer(405, { error: 'POST only' });
  if (!configured()) return answer(503, { error: 'harness not configured' });
  const text = await request.text();
  if (text.length > MAX_BODY) return answer(413, { error: `at most ${MAX_BODY} characters of body` });
  const body = parse(text);
  if (!sameToken(body.token, EXPECTED_TOKEN)) return answer(403, { error: 'forbidden' });
  const problem = requestProblem(body);
  if (problem !== null) return answer(400, { error: problem });
  return answer(200, { results: await runCalls(body.calls) });
}

return handle(event.request);
