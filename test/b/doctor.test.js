// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../../src/cli/main.js';

const INDEX = new URL('../../src/cli/index.js', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; } });
const emptyKeyring = { get: () => null, set() {}, delete: () => false };
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ version: '0.0.1' }) });

async function runDoctor(extraEnv = {}) {
  const home = tmp(); const out = cap();
  const env = { ...process.env, ONTOLOGIZER_HOME: home, HOME: home, ONTOLOGIZER_KEYRING: 'none', SHELL: '/bin/zsh', ...extraEnv };
  if (!('ANTHROPIC_API_KEY' in extraEnv)) delete env.ANTHROPIC_API_KEY;
  // @ts-ignore
  const code = await main(['doctor'], { env, home, stdout: out, stderr: cap(), interactive: false, keyring: emptyKeyring, fetch: okFetch });
  return { code, out: out.out };
}

test('doctor with no key: exit 1, fail row for API key with the fix', async () => {
  const { code, out } = await runDoctor();
  assert.equal(code, 1);
  assert.match(out, /^fail API key/m);
  assert.match(out, /fix: ontologizer key set/);
  assert.match(out, /^ok   Node/m);
  assert.match(out, /^warn Completion/m);
  assert.match(out, /eval "\$\(ontologizer completion zsh\)"/);
});

test('planted fault: with a key in env there are no fail rows and exit 0', async () => {
  const { code, out } = await runDoctor({ ANTHROPIC_API_KEY: 'sk-ant-test-0000' });
  assert.equal(code, 0);
  assert.doesNotMatch(out, /^fail/m);
  assert.match(out, /^ok   API key found \(env\)/m);
  assert.ok(!out.includes('sk-ant-test-0000'));
});

test('network failure only warns', async () => {
  const home = tmp(); const out = cap();
  const env = { ...process.env, ONTOLOGIZER_HOME: home, HOME: home, ANTHROPIC_API_KEY: 'sk-ant-test-0000' };
  // @ts-ignore
  const code = await main(['doctor'], { env, home, stdout: out, stderr: cap(), interactive: false, keyring: emptyKeyring, fetch: async () => { throw new Error('offline'); } });
  assert.equal(code, 0);
  assert.match(out.out, /^warn Network/m);
  assert.match(out.out, /^warn Version/m);
});

test('doctor via the CLI subprocess exits 1 with no key', () => {
  const home = tmp();
  const env = { ...process.env, ONTOLOGIZER_HOME: home, HOME: home, ONTOLOGIZER_KEYRING: 'none', ONTOLOGIZER_NO_UPDATE_CHECK: '1' };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync('node', [INDEX, 'doctor'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^fail API key/m);
});

test('doctor finishes within 5 s with no TTY, even when every network call hangs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
  const out = { out: '', write(/** @type {string} */ s) { this.out += s; } };
  const hang = () => new Promise(() => {}); // a fetch that never settles and ignores its signal
  const t0 = Date.now();
  const code = await main(['doctor'], {
    env: { ...process.env, ONTOLOGIZER_HOME: home, HOME: home, ONTOLOGIZER_KEYRING: 'none' },
    home, stdout: out, stderr: out, interactive: false,
    keyring: { get: () => null, set() {}, delete: () => false },
    fetch: /** @type {any} */ (hang),
  });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `doctor took ${ms} ms`);
  assert.equal(code, 1);
  assert.match(out.out, /warn Network/);
  assert.match(out.out, /warn Version/);
  // Planted fault: a doctor that awaits the raw fetch with no hard limit never finishes.
  const raw = await Promise.race([hang().then(() => 'done'), new Promise((r) => setTimeout(() => r('stuck'), 200))]);
  assert.equal(raw, 'stuck');
});

test('probeKeychain with ONTOLOGIZER_KEYRING=none never spawns or reads the keychain', async () => {
  const { probeKeychain } = await import('../../src/cli/apikey.js');
  assert.equal(probeKeychain({ env: { ONTOLOGIZER_KEYRING: 'none' } }), 'absent');
});

test('start menu "New map" keeps deps (non-enumerable on argv) when it calls the new handler', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
  const out = { out: '', write(/** @type {string} */ s) { this.out += s; } };
  const prompts = async () => ({
    select: async () => ({ a: 'new' }),
    input: async () => 'plastic modeling for a beginner',
    confirm: async () => false, // "Build it?" -> no: proves we got past deps.store()
    search: async () => { throw new Error('no'); }, password: async () => { throw new Error('no'); },
  });
  const code = await main([], {
    env: { ...process.env, ONTOLOGIZER_HOME: home, ANTHROPIC_API_KEY: 'sk-ant-test-0000', ONTOLOGIZER_ENGINE: 'stub' },
    home, stdout: out, stderr: out, interactive: true, prompts: /** @type {any} */ (prompts),
    keyring: { get: () => null, set() {}, delete: () => false },
  });
  assert.equal(code, 0, out.out);
  assert.match(out.out, /Suggested name: plastic-modeling/);
});
