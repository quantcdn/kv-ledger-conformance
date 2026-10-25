// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The proxy kvStore of the edge-harness adapter. Each method sends one call to harness-fn.js and returns its value,
// or rejects with an error rebuilt from the error fields. Local parts:
// - list/search return a thenable: await sends one page call; pages()/items()/[Symbol.asyncIterator] send one
//   iterate call (the function runs the whole iteration) and replay the collected values, then throw the error that
//   ended the iteration, if any. Nothing is sent before the first await or next().
// - atomic(storeId) is a local builder that records the ops; the first commit() sends them with two commit entries,
//   so the function also commits the same builder a second time. A second commit() here returns that second outcome
//   (the runtime's answer to a second commit), without one more request.
// - open(storeId) returns a local handle whose methods send 'handle' calls. kvStore.open is synchronous in the d.ts:
//   for a non-string store id the proxy repeats the outcome of open(123) that the adapter probed at start: a
//   synchronous throw when the runtime threw, a rejected promise when the runtime rejected.
// - verifyChain is synchronous in the d.ts (it returns a ChainReport, not a Promise), so it runs locally with the
//   suite's own implementation; harness-fn.js also runs it in the function for direct checks.
import { makeVerifyChain } from '../../lib/edge-surface.mjs';
import { encodeArgs, rebuildError } from './client.mjs';

const PLAIN = ['get', 'set', 'delete', 'getEntry', 'getMany', 'getBy', 'count', 'increment', 'append', 'ledgerStatus',
  'ledgerProof'];
const DONE = Object.freeze({ done: true, value: undefined });

/** invoke(call) -> value, or throws the rebuilt error. */
function createInvoke(send, KVError) {
  return async function invoke(call) {
    const [result] = await send([call]);
    if (!result.ok) throw rebuildError(result.error, KVError);
    return result.value;
  };
}

/** Replays one iterate call: the collected values, then the error that ended the iteration. */
class Replay {
  #load;
  #KVError;
  #outcome = null;
  #at = 0;
  #finished = false;

  constructor(load, KVError) {
    this.#load = load;
    this.#KVError = KVError;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async next() {
    if (this.#finished) return DONE;
    try {
      this.#outcome ??= await this.#load();
      return this.#step();
    } catch (err) {
      this.#finished = true;
      throw err;
    }
  }

  #step() {
    const { collected, error } = this.#outcome;
    if (this.#at < collected.length) return { done: false, value: collected[this.#at++] };
    this.#finished = true;
    if (error !== undefined) throw rebuildError(error, this.#KVError);
    return DONE;
  }

  async return() {
    this.#finished = true;
    return DONE;
  }
}

/** The result of list/search: a thenable of the first page with the iteration methods. */
class ProxyQuery {
  #invoke;
  #call;
  #KVError;
  #page = null;

  constructor(invoke, call, KVError) {
    this.#invoke = invoke;
    this.#call = call;
    this.#KVError = KVError;
  }

  then(onFulfilled, onRejected) {
    this.#page ??= this.#invoke(this.#call);
    return this.#page.then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.then(undefined, onRejected);
  }

  finally(onFinally) {
    return Promise.resolve(this).finally(onFinally);
  }

  #replay(mode, args) {
    const call = { ...this.#call, iterate: { mode, ...encodeArgs(args) } };
    return new Replay(() => this.#invoke(call), this.#KVError);
  }

  pages(...args) {
    return this.#replay('pages', args);
  }

  items(...args) {
    return this.#replay('items', args);
  }

  [Symbol.asyncIterator]() {
    return this.#replay('asyncIterator', []);
  }
}

/** The atomic builder: records ops; the first commit sends them, a later commit gives the second outcome. */
function createBuilder(invoke, target, KVError) {
  const ops = [];
  let outcomes = null;
  const builder = {};
  const add = (op, args) => {
    ops.push({ op, ...encodeArgs(args) });
    return builder;
  };
  for (const op of ['check', 'set', 'delete', 'increment']) builder[op] = (...args) => add(op, args);
  const settle = (outcome) => (outcome.ok ? outcome.value : Promise.reject(rebuildError(outcome.error, KVError)));
  builder.commit = async (...args) => {
    if (outcomes !== null) return settle(outcomes[1]);
    const entry = encodeArgs(args);
    ({ outcomes } = await invoke({ ...target, method: 'atomic', args: [], ops, commit: [entry, entry] }));
    return settle(outcomes[0]);
  };
  return builder;
}

/** Methods bound to a call target ({ shape, storeId }); `atStore` puts the store id first (global shape). */
function bindMethods(invoke, KVError, target) {
  const call = (method, args) => ({ ...target, method, ...encodeArgs(args) });
  const methods = {};
  for (const name of PLAIN) methods[name] = (...args) => invoke(call(name, args));
  for (const name of ['list', 'search']) methods[name] = (...args) => new ProxyQuery(invoke, call(name, args), KVError);
  methods.atomic = () => createBuilder(invoke, target, KVError);
  return methods;
}

function globalMethod(invoke, KVError, name) {
  return (storeId, ...args) => bindMethods(invoke, KVError, { shape: 'global', storeId })[name](...args);
}

function makeOpen(kvStore, invoke, KVError, probe) {
  return function open(storeId) {
    if (typeof storeId !== 'string' && !probe.nonString.ok) {
      const err = rebuildError(probe.nonString.error, KVError);
      if (probe.nonString.sync === true) throw err;
      return Promise.reject(err);
    }
    const handle = { storeId, ...bindMethods(invoke, KVError, { shape: 'handle', storeId }), verifyChain: kvStore.verifyChain };
    return probe.frozen ? Object.freeze(handle) : handle;
  };
}

/**
 * The proxy kvStore. probe: { nonString: the harness result of open(123), frozen: whether the runtime freezes a
 * handle }.
 */
export function buildProxyKvStore(send, KVError, probe) {
  const invoke = createInvoke(send, KVError);
  const kvStore = {};
  for (const name of [...PLAIN, 'list', 'search', 'atomic']) kvStore[name] = globalMethod(invoke, KVError, name);
  kvStore.verifyChain = makeVerifyChain(KVError);
  kvStore.open = makeOpen(kvStore, invoke, KVError, probe);
  Object.defineProperty(kvStore, 'KVError', { value: KVError, enumerable: false, writable: false, configurable: false });
  return kvStore;
}
