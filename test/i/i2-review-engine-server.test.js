// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// I2 review, server side: a connect that succeeds after its timeout is closed; headers on a command
// source are refused; a config file other users could change is refused before it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSources } from '../../src/server/sources.js';
import * as configMod from '../../src/server/config.js';
import { main } from '../../src/cli/main.js';

const { validateConfig, loadConfig, ConfigError } = configMod;
/** @type {(file: string, o?: { uid?: number, platform?: string }) => string|null} */
const configFileProblem = /** @type {any} */ (configMod).configFileProblem ?? (() => null);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onto-')));
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const posix = process.platform !== 'win32';

test('a connect that succeeds after its timeout has its client closed', async () => {
  /** @type {string[]} */ const events = [];
  const connect = async () => {
    await sleep(60);
    events.push('open');
    return { async listTools() { return { tools: [] }; }, async close() { events.push('close'); } };
  };
  const sources = createSources([{ name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'public', allowTools: ['search'] }], { connect, timeoutMs: 20 });
  const [row] = await sources.status();
  assert.equal(row.reachable, false);
  assert.match(String(row.error), /timed out/);
  await sleep(100);
  assert.deepEqual(events, ['open', 'close'], 'the late client was closed');
  await sources.close();
});

test('headers on a command source are refused with a clear message; on a url source they are fine', () => {
  const base = { name: 'docs', visibility: 'private', allowTools: ['search'], headers: () => ({}) };
  assert.deepEqual(validateConfig({ sources: [{ ...base, command: 'node' }] }), ['source "docs": headers only apply to url (a command source sends no headers)']);
  assert.deepEqual(validateConfig({ sources: [{ ...base, url: 'https://docs.example/mcp' }] }), []);
});

/** A folder holding a config that leaves a marker when it runs. */
function configIn(/** @type {string} */ dir) {
  const file = path.join(dir, 'ontologizer.config.js');
  const marker = path.join(dir, 'ran');
  fs.writeFileSync(file, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, '1');\nexport default {};\n`);
  return { file, marker };
}

test('a config other users could change is refused before it runs; the normal case loads', { skip: !posix }, async () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o700);
  const { file, marker } = configIn(dir);
  fs.chmodSync(file, 0o644);
  assert.deepEqual(await loadConfig(file), {});       // the user's own file in a private folder
  fs.rmSync(marker);
  for (const mode of [0o666, 0o664, 0o646]) {
    fs.chmodSync(file, mode);
    await assert.rejects(loadConfig(file), (/** @type {any} */ e) => e instanceof ConfigError && e.message.includes(file) && /refused: .*chmod go-w/.test(e.message), `mode ${mode.toString(8)}`);
    assert.equal(fs.existsSync(marker), false, 'its code never ran');
  }
  fs.chmodSync(file, 0o600);
  // a world-writable folder: refused, unless it has the sticky bit (like /tmp)
  fs.chmodSync(dir, 0o777);
  await assert.rejects(loadConfig(file), /refused: its folder .* can be written by anyone/);
  fs.chmodSync(dir, 0o1777);
  assert.equal(configFileProblem(file), null);
  fs.chmodSync(dir, 0o700);
  // a symlink is judged by its target
  const other = tmp();
  const link = path.join(other, 'link.config.js');
  fs.symlinkSync(file, link);
  fs.chmodSync(file, 0o666);
  assert.match(String(configFileProblem(link)), /can be changed by other users/);
  fs.chmodSync(file, 0o600);
  // owned by someone else (simulated uid); root-owned is fine; Windows is skipped
  const uid = /** @type {number} */ (process.getuid?.());
  assert.match(String(configFileProblem(file, { uid: uid + 1 })), /owned by another user .*chown/);
  assert.equal(configFileProblem(file, { uid }), null);
  fs.chmodSync(file, 0o666);
  assert.equal(configFileProblem(file, { uid, platform: 'win32' }), null);
});

test('read-only commands refuse an unsafe config too: status reports it and never runs it', { skip: !posix }, async () => {
  const home = tmp();
  const { file, marker } = configIn(home);
  fs.chmodSync(file, 0o666);
  let out = '';
  const stdout = { write(/** @type {string} */ s) { out += s; return true; } };
  const stderr = { write() { return true; } };
  await main(['status', '--json', '--home', home, '--config', file], { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {} });
  const j = JSON.parse(out);
  assert.match(String(j.configProblem), /refused: .*chmod go-w/);
  assert.equal(fs.existsSync(marker), false, 'the config never ran');
});
