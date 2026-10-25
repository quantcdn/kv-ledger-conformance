// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// A KVError class for adapters that have no runtime class of their own (the reference adapter, mocks).
import { DETAIL_FIELDS } from './error-contract.mjs';

const isScalar = (v) => typeof v === 'string' || typeof v === 'number';

function copyDetails(target, details) {
  for (const field of DETAIL_FIELDS) {
    if (isScalar(details[field])) target[field] = details[field];
  }
}

export function createKVErrorClass() {
  return class KVError extends Error {
    constructor(code, message, { status, retryable, ...details } = {}) {
      super(message);
      this.name = 'KVError';
      this.code = code;
      this.retryable = retryable === true; // always a boolean: only true is true
      if (status !== undefined) this.status = status;
      copyDetails(this, details);
    }
  };
}

export function isKVErrorLike(err) {
  return err !== null && typeof err === 'object' && err.name === 'KVError' && typeof err.code === 'string';
}
