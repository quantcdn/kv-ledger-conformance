// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Public-safety scan (spec 2 and 11): no file of the repository may hold cloud resource names, account ids or local
// paths. The scan reads every file that git tracks or would track (a directory walk when git is absent) and checks
// each line against a deny-list. This file holds generic patterns only, each built from parts so that this file does
// not match itself. Maintainers keep a private list of further patterns in an untracked file and name it in the
// environment variable KVC_SAFETY_DENYLIST (one regular expression per line; '#' starts a comment line).
// Binary files are skipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BINARY = new Set(['.tsr', '.crt', '.key', '.gz', '.der', '.png', '.jpg', '.ico']);
const WALK_SKIP = new Set(['.git', 'node_modules', '.superpowers']);

const part = (...pieces) => pieces.join('');

// [name, RegExp]: generic things that must never appear.
const GENERIC = [
  ['cloud provider host', new RegExp(part('amazon', 'aws', '\\.com'), 'i')],
  ['cloud provider host', new RegExp(part('\\.on', '\\.aws\\b'), 'i')],
  ['cloud provider host', new RegExp(part('cloud', 'front', '\\.net'), 'i')],
  ['cloud resource name', new RegExp(part('\\bar', 'n:a', 'ws[a-z-]*:'), 'i')],
  ['account id in an ARN position', new RegExp(part(':', '\\d{12}', ':'))],
  ['account id in an account context', new RegExp(part('\\b(?:acc', 'ount|own', 'er)[\\w ]{0,20}[:=\\s"\']+', '\\d{12}\\b'), 'i')],
  ['local path', new RegExp(part('/Us', 'ers/'))],
  ['local path', new RegExp(part('/ho', 'me/', '[a-z_][\\w.-]*/'))],
  ['local path', new RegExp(part('[A-Za-z]:\\\\', 'Us', 'ers\\\\'), 'i')],
  ['local temporary path', new RegExp(part('/priv', 'ate/', 'tmp/'))],
];

/** Patterns from a private deny-list file: one regular expression per line; blank lines and '#' lines skipped. */
export function loadDenylist(path) {
  return readFileSync(path, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((source, i) => [`private pattern ${i + 1}`, new RegExp(source, 'i')]);
}

const privatePath = process.env.KVC_SAFETY_DENYLIST;
const DENY = [...GENERIC, ...(privatePath ? loadDenylist(privatePath) : [])];

function gitFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (WALK_SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(ROOT, path));
  }
  return out;
}

const isText = (file, bytes) => !BINARY.has(extname(file).toLowerCase()) && !bytes.includes(0);

/** Every deny-list match in `text`: { line, name }. */
export function scanText(text, deny = DENY) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const [name, pattern] of deny) if (pattern.test(line)) hits.push({ line: index + 1, name });
  });
  return hits;
}

function scanFile(file) {
  let bytes;
  try {
    bytes = readFileSync(join(ROOT, file));
  } catch {
    return []; // listed but deleted from the working tree
  }
  if (!isText(file, bytes)) return [];
  return scanText(bytes.toString('utf8')).map((hit) => `${file}:${hit.line}: ${hit.name}`);
}

// One sample per generic pattern, in the order of GENERIC.
const SAMPLES = [
  part('https://s3.', 'amazon', 'aws.com/x'),
  part('https://abc.lambda-url.region', '.on', '.aws/'),
  part('https://d111.', 'cloud', 'front.net/x'),
  part('ar', 'n:aws:kms:region:', 'x:key/x'),
  part('arn-like :', '1234', '56789012', ':thing'),
  part('acc', 'ount id: ', '1234', '56789012'),
  part('/Us', 'ers/someone/x'),
  part('/ho', 'me/someone/x'),
  part('C:\\', 'Us', 'ers\\someone\\x'),
  part('/priv', 'ate/tmp/x'),
];

test('each generic pattern catches its sample', () => {
  assert.equal(SAMPLES.length, GENERIC.length);
  GENERIC.forEach(([name, pattern], i) => {
    assert.ok(pattern.test(SAMPLES[i]), `${name} (pattern ${i + 1}) has no match for its sample`);
  });
});

test('ordinary suite text does not match', () => {
  const clean = ['instanceName(org, store, collection, shard) => `${org}/${store}/${collection}#${shard}`',
    'audit#00', 'KVC_API_TOKEN', 'kvStore.get(storeId, key)', '"at": 1729814400000', 'home/page', 'an account of it'];
  for (const line of clean) assert.deepEqual(scanText(line, GENERIC), [], line);
});

test('a private deny-list file adds patterns; blank and comment lines are skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kvc-safety-'));
  try {
    const file = join(dir, 'deny.txt');
    writeFileSync(file, '# a comment\n\nsecret-thing\n  other[0-9]+  \n');
    const deny = loadDenylist(file);
    assert.deepEqual(deny.map(([name]) => name), ['private pattern 1', 'private pattern 2']);
    assert.equal(scanText('a SECRET-THING here', deny).length, 1);
    assert.equal(scanText('other42', deny).length, 1);
    assert.equal(scanText('# a comment', deny).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no file of the repository matches the deny-list', () => {
  const files = gitFiles() ?? walk(ROOT);
  assert.ok(files.length > 50, `found ${files.length} files`);
  const hits = files.flatMap(scanFile);
  assert.deepEqual(hits, [], `public-safety hits:\n${hits.join('\n')}`);
});
