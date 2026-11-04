#!/usr/bin/env node
/**
 * Verify relative Markdown links and anchors resolve.
 * External links and mail links are ignored.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const anchorCache = new Map();

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

function slug(text) {
  return text.trim().toLowerCase()
    .replace(/<[^>]+>/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_~]/gu, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim().replace(/\s+/gu, '-');
}

function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const used = new Map();
  const result = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!heading) continue;
    const base = slug(heading[1]);
    if (!base) continue;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(file, result);
  return result;
}

function check(file) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].trim();
    if (!target || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:')) continue;
    const [pathPart, rawAnchor] = target.split('#');
    const anchor = rawAnchor === undefined ? undefined : decodeURIComponent(rawAnchor);
    const resolved = pathPart ? resolve(dirname(file), pathPart) : file;
    try {
      statSync(resolved);
    } catch {
      failures.push({ file, target, reason: 'missing file' });
      continue;
    }
    if (anchor && !anchors(resolved).has(anchor)) {
      failures.push({ file, target, reason: `missing anchor #${anchor}` });
    }
  }
}

for (const file of markdownFiles(root)) check(file);

if (failures.length > 0) {
  console.error(`Broken relative links: ${failures.length}`);
  for (const failure of failures) {
    console.error(`  ${failure.file.slice(root.length + 1)} -> ${failure.target} (${failure.reason})`);
  }
  process.exitCode = 1;
} else {
  console.log('All relative Markdown links and anchors resolve.');
}
