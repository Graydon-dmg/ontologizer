// @ts-check
// ontologizer serve on a network address warns once that it is plain HTTP; on loopback it does not.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../src/cli/main.js';
import { tempHome } from './helpers-service.js';

function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }

/** @param {string} home @param {string[]} args */
async function run(home, args) {
  const stdout = cap(); const stderr = cap();
  const env = { ...process.env, ONTOLOGIZER_HOME: home };
  const code = await main(args, {
    home, stdout, stderr, interactive: false, openBrowser: async () => {}, onSignal: () => () => {}, env,
    keyring: { get: () => null, set() {}, delete: () => false },
  });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

const WARN = /plain HTTP\. Tokens and session cookies travel unencrypted/g;

test('serve --host 0.0.0.0 with a token warns once on stderr about plain HTTP', async () => {
  const home = tempHome();
  const c = await run(home, ['token', 'create', '--name', 'me', '--home', home]);
  assert.equal(c.code, 0, c.stderr);
  const r = await run(home, ['serve', '--host', '0.0.0.0', '--port', '0', '--home', home, '--exit-after', '200']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((r.stderr.match(WARN) ?? []).length, 1, r.stderr);
  assert.match(r.stderr, /HTTPS reverse proxy/);
  assert.match(r.stderr, /--allow-host/);
  assert.match(r.stderr, /127\.0\.0\.1/);
  assert.doesNotMatch(r.stdout, WARN);
});

test('serve on 127.0.0.1 prints no plain-HTTP warning', async () => {
  const home = tempHome();
  const r = await run(home, ['serve', '--port', '0', '--home', home, '--exit-after', '200']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, WARN);
});
