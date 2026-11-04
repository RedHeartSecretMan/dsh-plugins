#!/usr/bin/env node
/**
 * Verify every plugin release URL and version reference names the version in
 * that plugin's package.json. Catches stale install instructions after a bump.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

const files = markdownFiles(root);
const plugins = readdirSync(join(root, 'plugins'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      readFileSync(join(root, 'plugins', name, 'package.json'));
      return true;
    } catch {
      return false;
    }
  })
  .sort();

for (const plugin of plugins) {
  const pkg = JSON.parse(readFileSync(join(root, 'plugins', plugin, 'package.json'), 'utf8'));
  const version = pkg.version;
  const pattern = new RegExp(`releases/download/${plugin}-v(\\d+\\.\\d+\\.\\d+)/`, 'gu');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== version) {
        failures.push({
          file: file.slice(root.length + 1),
          expected: version,
          found: match[1],
        });
      }
    }
  }
  for (const relative of ['README.md', 'README.zh.md', 'docs/VALIDATION.md']) {
    const file = join(root, 'plugins', plugin, relative);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(`${plugin}-v${version}/${plugin}-${version}.tgz`)) {
      failures.push({ file: `plugins/${plugin}/${relative}`, expected: version, found: 'missing release URL' });
    }
  }
}

if (failures.length > 0) {
  console.error(`Version references out of date: ${failures.length}`);
  for (const failure of failures) {
    console.error(`  ${failure.file}: expected ${failure.expected}, found ${failure.found}`);
  }
  process.exitCode = 1;
} else {
  console.log('Plugin release URLs and version references match package.json.');
}
