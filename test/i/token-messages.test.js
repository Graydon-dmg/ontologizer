// @ts-check
// The token flow's messages tell the user what to do next, and never echo a token back.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { nextStep } from '../../src/cli/commands/token.js';
import { newToken } from '../../src/server/tokens.js';
import { tempHome } from './helpers-service.js';

function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }

/** @param {string} home @param {string[]} args */
async function run(home, args) {
  const stdout = cap(); const stderr = cap();
  const code = await main(args, {
    home, stdout, stderr, interactive: false, openBrowser: async () => {}, onSignal: () => () => {},
    env: { ...process.env, ONTOLOGIZER_HOME: home }, keyring: { get: () => null, set() {}, delete: () => false },
  });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

/**
 * The --tokens check: a token (or a path that is not a file) given to --tokens exits 1 with a message
 * that says what --tokens takes and where tokens live, and never repeats what was given.
 * @param {{ code: number, stdout: string, stderr: string }} r @param {string} given @param {string} home
 */
function tokensFlagProblems(r, given, home) {
  const problems = [];
  if (r.code !== 1) problems.push(`exit ${r.code}`);
  if (!r.stderr.includes('--tokens takes the path of a tokens file, not a token.')) problems.push('does not say what --tokens takes');
  if (!r.stderr.includes(`Tokens live in ${path.join(home, 'tokens.json')}`)) problems.push('does not say where tokens live');
  if ((r.stdout + r.stderr).includes(given)) problems.push('echoes the value given');
  if (given.startsWith('ont_') && (r.stdout + r.stderr).includes(given.slice(4, 14))) problems.push('echoes part of the token');
  return problems;
}

test('--tokens given a token (or a missing path) says what it takes, and never echoes the token', async () => {
  const home = tempHome();
  const token = newToken();
  const r = await run(home, ['serve', '--port', '0', '--home', home, '--tokens', token]);
  assert.deepEqual(tokensFlagProblems(r, token, home), []);
  const missing = path.join(home, 'no-such-file.json');
  assert.deepEqual(tokensFlagProblems(await run(home, ['serve', '--port', '0', '--home', home, '--tokens', missing]), missing, home), []);
  // Planted fault: the old message, which echoed the value as a path, is reported.
  const echoed = { code: 1, stdout: '', stderr: `No tokens file at ${path.join(home, token)}.\n` };
  assert.ok(tokensFlagProblems(echoed, token, home).includes('echoes the value given'));
});

/** @param {{ code: number, stderr: string }} r @param {string} home */
function refusalProblems(r, home) {
  const problems = [];
  if (r.code !== 1) problems.push(`exit ${r.code}`);
  if (!r.stderr.includes(`no tokens in ${path.join(home, 'tokens.json')}`)) problems.push('does not name the tokens file it looked in');
  if (!r.stderr.includes(`\`ontologizer token create --name <name> --home ${home}\``)) problems.push('does not give the create command for this home');
  if (!r.stderr.includes('then run serve again with the same --home')) problems.push('does not say to use the same --home');
  return problems;
}

test('the network-bind refusal names the home it looked in and the exact command to fix it', async () => {
  const home = tempHome();
  assert.deepEqual(refusalProblems(await run(home, ['serve', '--host', '0.0.0.0', '--port', '0', '--home', home]), home), []);
  // Planted fault: the old message, which named no home, is reported.
  const old = { code: 1, stderr: 'Refusing to listen on 0.0.0.0 without tokens: create one with `ontologizer token create`, or pass --tokens.\n' };
  assert.equal(refusalProblems(old, home).length, 3);
});

test('token create ends with the serve command to run next (with --home unless it is the default)', async () => {
  const home = tempHome();
  const r = await run(home, ['token', 'create', '--name', 'me', '--home', home]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^ont_[A-Za-z0-9_-]{43}$/);
  assert.equal(lines.at(-1), `Start the server with: ontologizer serve --home ${home} --host 0.0.0.0`);
  assert.equal(nextStep(path.join(os.homedir(), '.ontologizer')), 'Start the server with: ontologizer serve --host 0.0.0.0');
  assert.equal(nextStep('/tmp/with space'), "Start the server with: ontologizer serve --home '/tmp/with space' --host 0.0.0.0");
  // Only the first line carries the secret.
  assert.ok(!lines.slice(1).join('\n').includes(lines[0]));
});
