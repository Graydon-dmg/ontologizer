#!/usr/bin/env node
// @ts-check
// Usage: node scripts/test.js <folder>
// Finds every *.test.js under <folder>, skips any `live/` folder unless LIVE=1,
// and runs `node --test <files...>`. Exits 0 when there are no files.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.argv[2] || 'test');
const live = process.env.LIVE === '1';

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'live' && !live) continue;
      walk(p, out);
    } else if (name.endsWith('.test.js')) {
      out.push(p);
    }
  }
  return out;
}

// A path that is itself inside a live/ folder (e.g. test/c/live) still needs LIVE=1.
const insideLive = root.split(/[\\/]/).includes('live');
const files = !existsSync(root) || (insideLive && !live) ? [] : walk(root, []);
if (files.length === 0) {
  console.log(`no test files under ${process.argv[2] || 'test'}`);
  process.exit(0);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
