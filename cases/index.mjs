// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Every case module, aggregated. Later tasks add their modules here.
import { bytesCases } from './bytes.mjs';
import { coreSurfaceCases } from './core-surface.mjs';
import { coreKvCases } from './core-kv.mjs';
import { coreConditionalCases } from './core-conditional.mjs';
import { coreTtlCases } from './core-ttl.mjs';
import { coreIncrementCases } from './core-increment.mjs';
import { coreAtomicCases } from './core-atomic.mjs';
import { coreListCases } from './core-list.mjs';
import { coreCollectionCases } from './core-collections.mjs';
import { coreSearchCases } from './core-search.mjs';
import { coreSecretCases } from './core-secret.mjs';
import { coreIterationCases } from './core-iteration.mjs';
import { coreVerifyChainCases } from './core-verify-chain.mjs';
import { coreLimitCases } from './core-limits.mjs';
import { coreIndexCases } from './core-indexes.mjs';
import { ledgerAppendCases } from './ledger-append.mjs';
import { ledgerIdempotencyCases } from './ledger-idempotency.mjs';
import { ledgerValueCases } from './ledger-values.mjs';
import { ledgerReadCases } from './ledger-read.mjs';
import { proofTimingCases } from './proof-timing.mjs';
import { subjectV1Cases } from './subject-v1.mjs';

export function assertUniqueNames(list) {
  const seen = new Set();
  for (const c of list) {
    if (seen.has(c.name)) throw new Error(`duplicate case name: ${c.name}`);
    seen.add(c.name);
  }
  return list;
}

const coreCases = [
  ...coreSurfaceCases, ...coreKvCases, ...coreConditionalCases, ...coreTtlCases, ...coreIncrementCases,
  ...coreAtomicCases, ...coreListCases, ...coreCollectionCases, ...coreSearchCases, ...coreSecretCases,
  ...coreIterationCases, ...coreVerifyChainCases, ...coreLimitCases, ...coreIndexCases,
];

const ledgerCases = [...ledgerAppendCases, ...ledgerIdempotencyCases, ...ledgerValueCases, ...ledgerReadCases];

export const cases = Object.freeze(assertUniqueNames([...bytesCases, ...coreCases, ...ledgerCases, ...proofTimingCases,
  ...subjectV1Cases]));
