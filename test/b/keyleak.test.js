// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1'; process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { tempHome } from './helpers.js';

const KEY = 'sk-ant-test-LEAKCHECK-7f3a9c2e';
const TAIL = 'LEAKCHECK-7f3a9c2e';

/** All files under dir (recursive) that contain the key or its tail. @param {string} dir @returns {string[]} */
function scanForLeaks(dir) {
  /** @type {string[]} */ const hits = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!ent.isFile()) continue;
    const file = path.join(ent.parentPath ?? ent.path, ent.name);
    const body = fs.readFileSync(file, 'latin1');
    if (body.includes(KEY) || body.includes(TAIL)) hits.push(file);
  }
  return hits;
}

test('the key never reaches disk, stdout, stderr or process.env', async () => {
  const home = tempHome();
  const out = { s: '', write(/** @type {string} */ x) { this.s += x; } };
  const err = { s: '', write(/** @type {string} */ x) { this.s += x; } };
  const kr = { v: /** @type {string|null} */ (null), get() { return this.v; }, set(/** @type {string} */ k) { this.v = k; }, delete() { this.v = null; return true; } };
  let asks = 0;
  const env = { ...process.env, ONTOLOGIZER_HOME: home, ONTOLOGIZER_STUB_SPEED: '1000', ONTOLOGIZER_KEYRING: 'none' };
  delete env.ANTHROPIC_API_KEY;
  const code = await main(
    ['new', '--context', 'plastic modeling for a beginner', '--yes', '--no-open', '--exit-after-build'],
    { env, home, stdout: out, stderr: err, interactive: true, keyring: kr, validateKey: async () => 'ok', ask: async () => { asks++; return KEY; }, openBrowser: async () => {}, onSignal: () => () => {} },
  );
  assert.equal(code, 0, err.s);
  assert.equal(asks, 1);
  assert.equal(kr.v, KEY);
  assert.deepEqual(scanForLeaks(home), []);
  for (const text of [out.s, err.s]) {
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes(TAIL));
  }
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(fs.readdirSync(home).length > 0, 'the build wrote something to scan');

  // Planted fault: the same scanner must catch a key appended to a copied index.json.
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
  fs.cpSync(home, bad, { recursive: true });
  fs.appendFileSync(path.join(bad, 'index.json'), KEY);
  assert.deepEqual(scanForLeaks(bad).map((f) => path.basename(f)), ['index.json']);
});
