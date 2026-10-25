#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// CLI: node run.mjs --adapter <path> [--tags a,b] [--enable subject-v1] [--include p] [--exclude p] [--timeout-ms n]
//      [--json file] [--list]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cases as allCases } from './cases/index.mjs';
import { run } from './lib/runner.mjs';

const KNOWN_TAGS = ['bytes', 'core', 'ledger', 'proof-timing', 'subject-v1', 'message-exact'];
const OPTIONS = {
  adapter: { type: 'string' },
  tags: { type: 'string' },
  enable: { type: 'string' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'timeout-ms': { type: 'string' },
  json: { type: 'string' },
  list: { type: 'boolean' },
  help: { type: 'boolean' },
};
const USAGE = 'usage: node run.mjs --adapter <path> [--tags core,ledger] [--enable subject-v1] [--include <prefix>] ' +
  '[--exclude <prefix>] [--timeout-ms <ms>] [--json <file>] [--list]\n';

class UsageError extends Error {}

// A positive whole number of milliseconds, or undefined when the option is absent.
function timeoutOf(text) {
  if (text === undefined) return undefined;
  const ms = Number(text);
  if (!Number.isSafeInteger(ms) || ms <= 0 || !/^\d+$/.test(text)) throw new UsageError('--timeout-ms must be a positive whole number');
  return ms;
}

const split = (s) => (s === undefined ? undefined : s.split(',').map((t) => t.trim()).filter(Boolean));

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  const tags = split(values.tags);
  const unknown = (tags || []).find((t) => !KNOWN_TAGS.includes(t));
  if (unknown) throw new UsageError(`unknown tag: ${unknown}`);
  return { ...values, tags, enable: split(values.enable), timeoutMs: timeoutOf(values['timeout-ms']) };
}

const pad = (s, n) => s.padEnd(n);

function formatLine(r) {
  const shape = r.shape ? ` [${r.shape}]` : '';
  const tail = r.reason ? `  ${r.reason}` : `  (${r.ms} ms)`;
  return `${pad(r.status.toUpperCase(), 5)} ${r.name}${shape}${tail}\n`;
}

function formatSummary(report) {
  const s = report.summary;
  return `\n${report.adapter}: ${s.total} total, ${s.pass} pass, ${s.fail} fail, ${s.skip} skip, ${s.error} error\n`;
}

async function execute(args, io, cases) {
  const report = await run({
    adapter: args.adapter, tags: args.tags, enable: args.enable, include: args.include, exclude: args.exclude,
    timeoutMs: args.timeoutMs, cases, onResult: (r) => io.stdout(formatLine(r)),
  });
  io.stdout(formatSummary(report));
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2) + '\n');
  return report.summary.fail + report.summary.error > 0 ? 1 : 0;
}

// Help and list need no adapter. Each returns an exit code, or null when the run goes on.
function earlyExit(args, out, cases) {
  if (args.help) out.stdout(USAGE);
  else if (args.list) cases.forEach((c) => out.stdout(`${c.name}\t${c.tags.join(',')}\n`));
  else return null;
  return 0;
}

export async function main(argv, io = {}) {
  const out = { stdout: io.stdout || ((s) => process.stdout.write(s)), stderr: io.stderr || ((s) => process.stderr.write(s)) };
  const cases = io.cases || allCases;
  try {
    const args = parse(argv);
    const early = earlyExit(args, out, cases);
    return early === null ? await execute(args, out, cases) : early;
  } catch (err) {
    out.stderr(`error: ${err.message}\n${err instanceof UsageError ? USAGE : ''}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
