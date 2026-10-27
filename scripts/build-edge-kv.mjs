// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Builds packages/edge-kv: copies the edge layer, the local backend and every module they import into
// packages/edge-kv/src (same relative paths, so no import changes), plus the types, LICENSE and NOTICE.
// The copies are the same bytes as the sources, so the conformance suite tests the package code.
// Usage: node scripts/build-edge-kv.mjs (npm pack and npm publish in packages/edge-kv run it as prepack).
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'packages/edge-kv');

export const ENTRIES = [
  'lib/edge-surface.mjs',
  'lib/edge-calls.mjs',
  'lib/edge-checks.mjs',
  'lib/kv-error.mjs',
  'lib/clock.mjs',
  'lib/limits.mjs',
  'lib/error-contract.mjs',
  'adapters/reference/backend/index.mjs',
];

// from '…', import '…' and import('…') of a relative path.
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/** Every module the entries import, by relative path from the repository root, sorted. */
export function moduleClosure(entries = ENTRIES) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) queue.push(normalize(join(dirname(file), spec)));
  }
  return [...seen].sort();
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

export function build() {
  rmSync(join(OUT, 'src'), { recursive: true, force: true });
  const files = moduleClosure();
  for (const file of files) copy(join(ROOT, file), join(OUT, 'src', file));
  copy(join(ROOT, 'types/kvstore.d.ts'), join(OUT, 'types/kvstore.d.ts'));
  for (const file of ['LICENSE', 'NOTICE']) copy(join(ROOT, file), join(OUT, file));
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = build();
  console.log(`edge-kv: ${files.length} modules copied`);
}
