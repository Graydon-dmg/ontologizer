// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../../src/cli/main.js';
import { openStore } from '../../src/core/store.js';
import { TOKEN_RE } from '../../src/server/tokens.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }

/** @param {string[]} args @param {string} home */
async function run(args, home) {
  const stdout = cap(); const stderr = cap();
  const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {} });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

/** Problems: output must not contain the secret. @param {string} out @param {string} secret */
const leaks = (out, secret) => (out.includes(secret) ? ['secret printed'] : []);

test('token create prints the secret once; nothing else does', async () => {
  const home = tmp();
  const c = await run(['token', 'create', '--name', 'ci', '--tenant', 'acme', '--scopes', 'read', '--home', home], home);
  assert.equal(c.code, 0, c.stderr);
  const lines = c.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], TOKEN_RE);
  assert.match(lines[1], /shown once/);
  const secret = lines[0];
  for (const args of [['token', 'list'], ['token', 'list', '--json'], ['status'], ['status', '--json']]) {
    const r = await run([...args, '--home', home], home);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(leaks(r.stdout + r.stderr, secret), [], args.join(' '));
  }
  // fault: the scan catches an output containing the secret
  assert.ok(leaks(`token ${secret}`, secret).length > 0);
  const list = JSON.parse((await run(['token', 'list', '--json', '--home', home], home)).stdout);
  assert.deepEqual(list.map((/** @type {any} */ r) => [r.name, r.tenant, r.scopes]), [['ci', 'acme', ['read']]]);
});

test('token errors exit 1', async () => {
  const home = tmp();
  await run(['token', 'create', '--name', 'ci', '--home', home], home);
  assert.equal((await run(['token', 'create', '--name', 'ci', '--home', home], home)).code, 1);
  const bad = await run(['token', 'create', '--name', 'x', '--scopes', 'read,root', '--home', home], home);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /read, ask, build, admin/);
  assert.equal((await run(['token', 'revoke', 'nope', '--home', home], home)).code, 1);
  assert.equal((await run(['token', '--home', home], home)).code, 1);
  const ok = await run(['token', 'revoke', 'ci', '--home', home], home);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match((await run(['token', 'list', '--home', home], home)).stdout, /No tokens/);
});

test('status: tenants, no tokens file created, server only when pid is live', async () => {
  const home = tmp();
  openStore(home).createDraft('one');
  openStore(home, { tenant: 'acme' }).createDraft('two');
  fs.mkdirSync(path.join(home, 'tenants', 'Bad_Name'), { recursive: true });
  const r = await run(['status', '--home', home], home);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /No tokens: service mode listens on loopback only\./);
  assert.match(r.stdout, /Server: not running/);
  assert.ok(!fs.existsSync(path.join(home, 'tokens.json')));
  const j = JSON.parse((await run(['status', '--json', '--home', home], home)).stdout);
  assert.deepEqual(j.tenants, [{ tenant: 'default', maps: 1 }, { tenant: 'acme', maps: 1 }]);
  assert.equal(j.server, null);
  assert.deepEqual(j.tokens, []);

  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(path.join(home, 'serve.json'), JSON.stringify({ url: 'http://127.0.0.1:9/', pid: dead, startedAt: 'x' }));
  assert.equal(JSON.parse((await run(['status', '--json', '--home', home], home)).stdout).server, null);
  fs.writeFileSync(path.join(home, 'serve.json'), JSON.stringify({ url: 'http://127.0.0.1:9/', pid: process.pid, startedAt: 'x' }));
  const live = await run(['status', '--home', home], home);
  assert.match(live.stdout, new RegExp(`Server: running at http://127.0.0.1:9/ \\(pid ${process.pid}\\)`));
  assert.equal(JSON.parse((await run(['status', '--json', '--home', home], home)).stdout).server.pid, process.pid);
  // status does not create a tenant dir for a home that has none
  const empty = tmp();
  await run(['status', '--home', empty], empty);
  assert.ok(!fs.existsSync(path.join(empty, 'tenants')));
});
