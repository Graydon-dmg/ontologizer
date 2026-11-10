// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findConfig, validateConfig, loadConfig, portNames, ConfigError, CONFIG_NAME } from '../../src/server/config.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onto-')));
const src = (/** @type {any} */ o = {}) => ({ name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'public', allowTools: ['search'], ...o });

test('valid configs pass', () => {
  assert.deepEqual(validateConfig({}), []);
  assert.deepEqual(validateConfig({
    identity: { name: 'sso', authenticate() { return null; } }, policy: { can() { return true; } },
    store() {}, model() {},
    sources: [src(), src({ name: 'docs', url: undefined, command: 'node', args: ['x.js'], visibility: 'private' }), src({ name: 'hr', headers: () => ({}) })],
  }), []);
});

test('every invalid shape is reported; planted faults', () => {
  const has = (/** @type {any} */ cfg, /** @type {RegExp} */ re) => validateConfig(cfg).some((p) => re.test(p));
  assert.ok(has({ sourcez: [] }, /unknown key "sourcez"/));
  assert.ok(has('x', /must be an object/));
  assert.ok(has({ sources: [src({ visibility: undefined })] }, /visibility/));
  assert.ok(has({ sources: [src({ command: 'node' })] }, /exactly one of url or command/));
  assert.ok(has({ sources: [src({ url: undefined })] }, /exactly one of url or command/));
  assert.ok(has({ sources: [src({ url: 'ftp://x.example' })] }, /http or https/));
  assert.ok(has({ sources: [src({ name: 'Bad Name' })] }, /name must match/));
  assert.ok(has({ sources: [src(), src()] }, /duplicate/));
  assert.ok(has({ sources: [src({ allowTools: [] })] }, /allowTools/));
  assert.ok(has({ sources: [src({ allowTools: [''] })] }, /allowTools/));
  assert.ok(has({ sources: [src({ headers: 'x' })] }, /headers/));
  assert.ok(has({ sources: [src({ extra: 1 })] }, /unknown key "extra"/));
  assert.ok(has({ sources: [src({ url: undefined, command: 'node', args: [1] })] }, /args/));
  assert.ok(has({ identity: {} }, /authenticate/));
  assert.ok(has({ policy: { can: 1 } }, /can function/));
  assert.ok(has({ store: {} }, /store must be a function/));
  assert.ok(has({ model: 'x' }, /model must be a function/));
  assert.ok(has({ sources: {} }, /array/));
});

test('findConfig: flag, env, home; never the current folder', () => {
  const home = tmp(); const cwdDir = tmp(); const old = process.cwd();
  fs.writeFileSync(path.join(cwdDir, CONFIG_NAME), 'export default {};');
  try {
    process.chdir(cwdDir);
    assert.equal(findConfig({ env: {}, home }), null); // planted: a config in the cwd is ignored
    fs.writeFileSync(path.join(home, CONFIG_NAME), 'export default {};');
    assert.equal(findConfig({ env: {}, home }), path.join(home, CONFIG_NAME));
    const other = path.join(cwdDir, CONFIG_NAME);
    assert.equal(findConfig({ flag: other, env: { ONTOLOGIZER_CONFIG: '/nope' }, home }), other);
    assert.equal(findConfig({ env: { ONTOLOGIZER_CONFIG: other }, home }), other);
  } finally { process.chdir(old); }
  assert.throws(() => findConfig({ flag: path.join(home, 'missing.js'), env: {}, home }), (/** @type {any} */ e) => e instanceof ConfigError && /^Config .*missing\.js: not found$/.test(e.message));
  assert.throws(() => findConfig({ env: { ONTOLOGIZER_CONFIG: path.join(home, 'gone.js') }, home }), /not found/);
});

test('loadConfig: loads, reports every problem, wraps import errors, re-imports changes', async () => {
  const dir = tmp(); const f = path.join(dir, CONFIG_NAME);
  fs.writeFileSync(f, 'export default { sources: [{ name: "wiki", url: "https://wiki.example/mcp", visibility: "public", allowTools: ["search"] }] };');
  assert.equal((await loadConfig(f)).sources[0].name, 'wiki');
  fs.writeFileSync(f, 'export default { sources: [{ name: "docs", url: "https://docs.example/mcp", visibility: "private", allowTools: ["get"] }] };');
  assert.equal((await loadConfig(f)).sources[0].name, 'docs'); // changed file is re-imported
  fs.writeFileSync(f, 'export default { sourcez: [], store: 1 };');
  await assert.rejects(loadConfig(f), (/** @type {any} */ e) => {
    const lines = e.message.split('\n');
    return e instanceof ConfigError && lines.length === 2 && lines.every((/** @type {string} */ l) => l.startsWith(`Config ${f}: `));
  });
  fs.writeFileSync(f, 'throw new Error("boom");');
  await assert.rejects(loadConfig(f), new RegExp(`Config ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: could not load: boom$`));
});

test('portNames', () => {
  assert.deepEqual(portNames(null), { identity: 'tokens', policy: 'default', store: 'files', model: 'default' });
  assert.deepEqual(portNames({}), { identity: 'tokens', policy: 'default', store: 'files', model: 'default' });
  function pg() {}
  assert.deepEqual(portNames({ identity: { name: 'sso', authenticate() {} }, policy: { can() {} }, store: pg, model: [() => 1][0] }),
    { identity: 'sso', policy: 'custom', store: 'pg', model: 'custom' });
  assert.equal(portNames({ store: (() => () => 1)() }).store, 'custom');
});
