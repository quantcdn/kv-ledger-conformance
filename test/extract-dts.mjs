// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// One-off extractor. Usage: node test/extract-dts.mjs <path-to-kvstore.d.ts> > fixtures/kvstore-error-codes.json
// Reads the KVErrorCode union and the optional detail fields of the KVError interface.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NOT_DETAIL = new Set(['name', 'code', 'retryable', 'status']);

function block(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) throw new Error(`not found: ${startPattern}`);
  const rest = text.slice(start);
  const end = rest.search(endPattern);
  return end < 0 ? rest : rest.slice(0, end);
}

export function extractCodes(text) {
  const union = block(text, /type KVErrorCode\s*=/, /;\s*\n/);
  return [...union.matchAll(/\|\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
}

export function extractDetailFields(text) {
  const body = block(text, /interface KVError extends Error\s*\{/, /\n\}/);
  const names = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  return names.filter((n) => !NOT_DETAIL.has(n));
}

export function extract(text) {
  return { codes: extractCodes(text), detailFields: extractDetailFields(text) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!process.argv[2]) throw new Error('usage: node test/extract-dts.mjs <kvstore.d.ts>');
  process.stdout.write(JSON.stringify(extract(readFileSync(process.argv[2], 'utf8')), null, 2) + '\n');
}
