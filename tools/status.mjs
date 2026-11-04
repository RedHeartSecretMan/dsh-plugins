#!/usr/bin/env node
/**
 * Show which plugins changed since their own last release tag.
 *
 * The repository releases each plugin independently, so this is the first
 * command to run before deciding what to release. It never mutates anything.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsRoot = join(root, 'plugins');
const asJson = process.argv.includes('--json');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function pluginNames() {
  return readdirSync(pluginsRoot).filter((name) => {
    try {
      readFileSync(join(pluginsRoot, name, 'package.json'));
      return true;
    } catch {
      return false;
    }
  }).sort();
}

const rows = pluginNames().map((name) => {
  const pkg = JSON.parse(readFileSync(join(pluginsRoot, name, 'package.json'), 'utf8'));
  const dir = `plugins/${name}`;
  const tags = git('tag', '--list', `${name}-v*`, '--sort=-v:refname').split('\n').filter(Boolean);
  const latestTag = tags[0] ?? null;
  const releasedVersion = latestTag === null ? null : latestTag.slice(name.length + 2);
  const commits = latestTag === null
    ? []
    : git('log', '--format=%h %s', `${latestTag}..HEAD`, '--', dir).split('\n').filter(Boolean);
  return { name, version: pkg.version, latestTag, releasedVersion, commits };
});

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

for (const row of rows) {
  const state = row.latestTag === null
    ? 'no release tag yet'
    : row.commits.length > 0 ? `${row.commits.length} commit(s) since ${row.latestTag}` : 'unchanged';
  const version = row.releasedVersion === null || row.releasedVersion === row.version
    ? row.version
    : `${row.releasedVersion} → ${row.version} (bump pending)`;
  console.log(`${row.name}  ${version}`);
  console.log(`  last tag: ${row.latestTag ?? '—'}  ${state}`);
  for (const commit of row.commits.slice(0, 8)) console.log(`  - ${commit}`);
}
