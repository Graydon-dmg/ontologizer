// @ts-check
// ontologizer serve: the network-bind refusal, serve.json while running, the startup line.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { tempHome, req, seed } from './helpers-service.js';

function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }

/** @param {string} home @param {string[]} args */
async function run(home, args) {
  const stdout = cap(); const stderr = cap();
  const env = { ...process.env, ONTOLOGIZER_HOME: home, ONTOLOGIZER_STUB_SPEED: '1000' };
  const code = await main(args, {
    home, stdout, stderr, interactive: false, openBrowser: async () => {}, onSignal: () => () => {}, env,
    keyring: { get: () => null, set() {}, delete: () => false },
  });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

/**
 * The refusal check: `serve --host 0.0.0.0` without tokens exits 1, says how to fix it, and leaves
 * nothing listening behind (no serve.json).
 * @param {{ code: number, stdout: string, stderr: string }} r @param {string} home
 */
function refusalProblems(r, home) {
  const problems = [];
  if (r.code !== 1) problems.push(`exit code ${r.code}`);
  if (!r.stderr.includes(`Refusing to listen on 0.0.0.0: no tokens in ${path.join(home, 'tokens.json')}`)) problems.push('no refusal message naming the home');
  if (!r.stderr.includes(`ontologizer token create --name <name> --home ${home}`)) problems.push('the message does not name `ontologizer token create` with this --home');
  if (fs.existsSync(path.join(home, 'serve.json'))) problems.push('serve.json was written');
  if (/Serving /.test(r.stdout)) problems.push('it started serving');
  return problems;
}

test('serve --host 0.0.0.0 with no tokens exits 1 and the message names `ontologizer token create`', async () => {
  const home = tempHome();
  const r = await run(home, ['serve', '--host', '0.0.0.0', '--port', '0', '--home', home]);
  assert.deepEqual(refusalProblems(r, home), []);
  // An empty tokens file (every token revoked) is no tokens.
  fs.writeFileSync(path.join(home, 'tokens.json'), '[]');
  assert.deepEqual(refusalProblems(await run(home, ['serve', '--host', '0.0.0.0', '--port', '0', '--home', home]), home), []);
  // Planted fault: a serve that only warns (prints, then serves, exit 0) is reported.
  const warnsOnly = { code: 0, stdout: 'Serving 0 maps at http://0.0.0.0:8787/\n', stderr: 'Warning: listening on 0.0.0.0 without tokens.\n' };
  assert.ok(refusalProblems(warnsOnly, home).length >= 3);
});

test('serve on loopback: prints the line, writes serve.json while running, removes it on exit; status sees it', async () => {
  const home = tempHome();
  await seed(home, 'default', 'demo');
  const running = run(home, ['serve', '--port', '0', '--home', home, '--exit-after', '1500']);
  const file = path.join(home, 'serve.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
  assert.equal((await req(info.url, '/v1/health/live')).status, 200);
  assert.equal((await req(info.url, '/v1/t/default/maps')).json()[0].id, 'demo');
  const st = await run(home, ['status', '--home', home, '--json']);
  assert.equal(JSON.parse(st.stdout).server.url, info.url);
  const r = await running;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Serving 1 map at ${info.url.replace(/[/.]/g, '\\$&')}  \\(Ctrl-C to stop\\)$`, 'm'));
  assert.ok(!fs.existsSync(file), 'serve.json is removed on exit');
});

test('with a token, serve --host 0.0.0.0 starts, and every /v1/t/ route then needs the token', async () => {
  const home = tempHome();
  const c = await run(home, ['token', 'create', '--name', 'me', '--home', home]);
  assert.equal(c.code, 0, c.stderr);
  const token = c.stdout.split('\n')[0];
  const running = run(home, ['serve', '--host', '0.0.0.0', '--port', '0', '--home', home, '--exit-after', '1000']);
  const file = path.join(home, 'serve.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  const { url } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal((await req(url, '/v1/t/default/maps')).status, 401);
  assert.equal((await req(url, '/v1/t/default/maps', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const r = await running;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), 'serve never prints a secret');
});

test('serve refuses a --tokens file that does not exist', async () => {
  const home = tempHome();
  const r = await run(home, ['serve', '--port', '0', '--home', home, '--tokens', path.join(home, 'nope.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--tokens takes the path of a tokens file/);
});
