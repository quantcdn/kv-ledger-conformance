// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// PagedQuery (kvstore.d.ts, API page "Iteration over list and search"): a Promise of the first page that is also
// async-iterable, with pages(options) and items(options). Each page after the first is one more request with the
// same options plus the cursor of the page before. Page cap: LIMITS.maxPages (default, min, max). When pages remain
// after the cap, the next step throws LIMIT_EXCEEDED (not retryable) with the cursor to resume from.
import { LIMITS } from './limits.mjs';
import { isIntIn, isPlainObject } from './check-util.mjs';

/** Calls fn and always returns a fresh promise: a synchronous throw becomes a rejection. */
export function callAsync(fn, thisArg, args) {
  return new Promise((resolve) => resolve(fn.apply(thisArg, args)));
}

// [rule that must hold, problem text]. Checked in order on a defined options value.
const ITERATION_RULES = [
  [isPlainObject, 'iteration options must be a plain object'],
  [(o) => Object.keys(o).every((name) => name === 'maxPages'), 'maxPages is the only iteration option'],
  [(o) => o.maxPages === undefined || isIntIn(o.maxPages, LIMITS.maxPages), 'maxPages is out of range or not an integer'],
];

function iterationProblem(options) {
  if (options === undefined) return null;
  const broken = ITERATION_RULES.find(([holds]) => !holds(options));
  return broken === undefined ? null : broken[1];
}

const DONE = Object.freeze({ done: true, value: undefined });
const hasFollowingPage = (page) => Boolean(page.hasMore) && typeof page.cursor === 'string';

/** Async iterator over pages. State: the last page read and how many pages this iteration has read. */
class PageCursor {
  #first;
  #fetch;
  #cap;
  #KVError;
  #last = null;
  #read = 0;
  #finished = false;

  constructor(first, fetch, cap, KVError) {
    this.#first = first;
    this.#fetch = fetch;
    this.#cap = cap;
    this.#KVError = KVError;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  // The promise of the next page, or null at the end. Throws LIMIT_EXCEEDED at the cap.
  #request() {
    if (this.#last === null) return this.#first;
    if (!hasFollowingPage(this.#last)) return null;
    if (this.#read >= this.#cap) {
      throw new this.#KVError('LIMIT_EXCEEDED', `page cap of ${this.#cap} reached; resume with the cursor`,
        { cursor: this.#last.cursor });
    }
    return this.#fetch(this.#last.cursor);
  }

  async next() {
    if (this.#finished) return DONE;
    try {
      const page = await this.#request();
      if (page === null) return this.return();
      this.#last = page;
      this.#read += 1;
      return { done: false, value: page };
    } catch (err) {
      this.#finished = true;
      throw err;
    }
  }

  async return() {
    this.#finished = true;
    return DONE;
  }
}

/** Async iterator over the items of a PageCursor. A page without an items array gives no items. */
class ItemCursor {
  #pages;
  #items = [];
  #at = 0;

  constructor(pages) {
    this.#pages = pages;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async next() {
    while (this.#at >= this.#items.length) {
      const step = await this.#pages.next();
      if (step.done) return DONE;
      this.#items = Array.isArray(step.value.items) ? step.value.items : [];
      this.#at = 0;
    }
    this.#at += 1;
    return { done: false, value: this.#items[this.#at - 1] };
  }

  return() {
    return this.#pages.return();
  }
}

/** The first-page promise. Derived promises (then, catch) are plain Promises. */
class PagedQuery extends Promise {
  static get [Symbol.species]() {
    return Promise;
  }

  #fetch;
  #KVError;

  constructor(executor, fetch, KVError) {
    super(executor);
    this.#fetch = fetch;
    this.#KVError = KVError;
  }

  #capOf(options) {
    const problem = iterationProblem(options);
    if (problem === null) return options?.maxPages ?? LIMITS.maxPages.default;
    // This call ends here, so it never reads the first page. If the first request fails, nothing else may
    // observe it: attach a no-op handler so the failure is not reported as an unhandled rejection.
    this.then(undefined, () => {});
    throw new this.#KVError('VALIDATION', problem);
  }

  pages(options) {
    return new PageCursor(this, this.#fetch, this.#capOf(options), this.#KVError);
  }

  items(options) {
    return new ItemCursor(this.pages(options));
  }

  [Symbol.asyncIterator]() {
    return this.items();
  }
}

/** query(options) resolves to one page. Returns a PagedQuery whose first request is already sent. */
export function pagedQuery(query, options, KVError) {
  const fetch = (cursor) => callAsync(query, undefined, [cursor === undefined ? options : { ...options, cursor }]);
  return new PagedQuery((resolve) => resolve(fetch(undefined)), fetch, KVError);
}
