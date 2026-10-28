// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// prepublishOnly of packages/edge-kv: a prerelease version (for example 0.2.0-rc.0) must not become `latest`.
// npm publish uses the tag `latest` unless --tag is given, so a prerelease needs --tag next.
import { readFileSync } from 'node:fs';

export function tagProblem(version, tag) {
  const prerelease = version.includes('-');
  const chosen = tag || 'latest';
  if (prerelease && chosen === 'latest') return `${version} is a prerelease: publish it with --tag next`;
  if (!prerelease && chosen !== 'latest') return `${version} is a stable version: publish it without --tag (latest)`;
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('check-publish-tag.mjs')) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const problem = tagProblem(version, process.env.npm_config_tag);
  if (problem) {
    console.error(`publish refused: ${problem}`);
    process.exit(1);
  }
}
