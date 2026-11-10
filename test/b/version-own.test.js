// @ts-check
// `--version` prints ontologizer's own version even when run from inside another project
// (yargs would otherwise guess a package.json from where it is installed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const own = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

test('--version prints our own version, not the version of the project it runs in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-ver-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'host', version: '9.9.9' }));
    const out = execFileSync(process.execPath, [path.join(root, 'src/cli/index.js'), '--version'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(out, own);
    assert.notEqual(out, '9.9.9');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('main.js hands yargs an explicit version (yargs\'s own guess reads the wrong package.json when installed as a dependency)', () => {
  const src = fs.readFileSync(path.join(root, 'src/cli/main.js'), 'utf8');
  assert.match(src, /\.version\(version\)/);
  assert.doesNotMatch(src, /\.version\(\)/);
});
