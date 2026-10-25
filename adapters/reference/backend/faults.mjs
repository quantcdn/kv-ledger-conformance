// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Fault injection: the next call of an operation fails with UNAVAILABLE. 'before' writes nothing;
// 'after-write' performs the write and then loses the response.
const OPS = new Set(['set', 'delete', 'increment', 'commit', 'append']);
const WHEN = new Set(['before', 'after-write']);

export function createFaults(core) {
  const pending = new Map();

  function inject({ op, when } = {}) {
    if (!OPS.has(op) || !WHEN.has(when)) {
      throw core.error('VALIDATION', `injectFault takes op ${[...OPS].join('|')} and when before|after-write`);
    }
    pending.set(op, when);
  }

  const unavailable = (op, retryable, details) => core.error('UNAVAILABLE',
    `injected fault: the ${op} response was lost; the outcome is unknown`, { status: 503, retryable, ...details });

  /**
   * Runs work() under any pending fault for op. details go on the error (for example idempotencyKey).
   * retryableBefore: the retryable flag of a 'before' fault (nothing written), when it differs from retryable.
   */
  function run(op, { retryable, retryableBefore = retryable, details }, work) {
    const when = pending.get(op);
    pending.delete(op);
    if (when === 'before') throw unavailable(op, retryableBefore, details);
    const result = work();
    if (when === 'after-write') throw unavailable(op, retryable, details);
    return result;
  }

  return { inject, run };
}
