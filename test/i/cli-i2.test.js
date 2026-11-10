// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { complete } from '../../src/cli/complete.js';
import { openStore } from '../../src/core/store.js';
import { readTokens, tokensPath } from '../../src/server/tokens.js';
import { fixtureEvents } from './helpers-service.js';

const STUB = new URL('./fixtures/stub-mcp.js', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }

/** @param {string[]} args @param {string} home @param {Record<string,string>} [env] @param {string} [cwd] */
async function run(args, home, env = {}, cwd) {
  const stdout = cap(); const stderr = cap();
  const prev = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home, ...env }, openBrowser: async () => {}, onSignal: () => () => {} });
    return { code, stdout: stdout.out, stderr: stderr.out };
  } finally {
    if (cwd) process.chdir(prev);
  }
}
const CONFIG = (/** @type {string} */ home) => path.join(home, 'ontologizer.config.js');
const stdioSource = (/** @type {any} */ over = {}) => ({ name: 'wiki', command: process.execPath, args: [STUB], visibility: 'public', allowTools: ['search', 'get'], ...over });
/** @param {string} home @param {any[]} sources */
const writeConfig = (home, sources) => fs.writeFileSync(CONFIG(home), `export default { sources: ${JSON.stringify(sources)} };\n`);

test('token create --sources: stored in the row, the file still holds only hashes; no flag, no key', async () => {
  const home = tmp();
  const c = await run(['token', 'create', '--name', 'a', '--sources', 'wiki,docs,wiki', '--home', home], home);
  assert.equal(c.code, 0, c.stderr);
  const secret = c.stdout.split('\n')[0];
  await run(['token', 'create', '--name', 'b', '--home', home], home);
  const rows = readTokens(tokensPath(home));
  assert.deepEqual(rows[0].sources, ['wiki', 'docs']);
  assert.equal('sources' in rows[1], false);
  assert.equal(fs.readFileSync(tokensPath(home), 'utf8').includes(secret), false);
  // planted fault: a row whose sources is not an array is rejected
  const bad = path.join(home, 'bad-tokens.json');
  fs.writeFileSync(bad, JSON.stringify([{ ...rows[0], sources: 'wiki' }]));
  assert.throws(() => readTokens(bad), /row 1/);
  fs.writeFileSync(bad, JSON.stringify([{ ...rows[0], sources: [1] }]));
  assert.throws(() => readTokens(bad), /row 1/);
});

test('token list shows sources (text and json); a token without them shows none', async () => {
  const home = tmp();
  await run(['token', 'create', '--name', 'a', '--sources', 'wiki,docs', '--home', home], home);
  await run(['token', 'create', '--name', 'b', '--home', home], home);
  const lines = (await run(['token', 'list', '--home', home], home)).stdout.trim().split('\n');
  assert.match(lines[0], /^a {2}tenant default {2}scopes read,build {2}sources wiki,docs {2}\d{4}-/);
  assert.equal(/sources/.test(lines[1]), false); // planted: a list that printed "sources" for b would fail here
  const j = JSON.parse((await run(['token', 'list', '--json', '--home', home], home)).stdout);
  assert.deepEqual(j[0].sources, ['wiki', 'docs']);
  assert.equal('sources' in j[1], false);
});

test('token create --sources: an empty or invalid list exits 1 and creates nothing', async () => {
  const home = tmp();
  for (const v of ['', ',', 'Wiki', 'a b', 'x_y']) {
    const r = await run(['token', 'create', '--name', 'x', '--sources', v, '--home', home], home);
    assert.equal(r.code, 1, `"${v}"`);
    assert.match(r.stderr, /Invalid sources/);
  }
  assert.equal(fs.existsSync(tokensPath(home)), false);
});

test('token create notes an unknown source name when a config is present, and still creates it', async () => {
  const home = tmp();
  const quiet = await run(['token', 'create', '--name', 'q', '--sources', 'ghost', '--home', home], home);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stderr, ''); // no config: no note
  writeConfig(home, [stdioSource()]);
  const r = await run(['token', 'create', '--name', 'n', '--sources', 'wiki,ghost', '--home', home], home);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, `Note: no source named "ghost" in ${CONFIG(home)}.\n`); // wiki is configured: no note for it
  assert.deepEqual(readTokens(tokensPath(home)).find((x) => x.name === 'n')?.sources, ['wiki', 'ghost']);
  // a config that does not load is skipped, not an error
  fs.writeFileSync(CONFIG(home), 'export default { nope: 1 };');
  const broken = await run(['token', 'create', '--name', 'm', '--sources', 'ghost', '--home', home], home);
  assert.equal(broken.code, 0);
  assert.equal(broken.stderr, '');
});

test('list: public for a fixture map, private after visibility.raised', async () => {
  const home = tmp();
  const store = openStore(home);
  store.importEvents('open-map', fixtureEvents('plastic-modeling'));
  store.importEvents('secret-map', [...fixtureEvents('plastic-modeling'), { t: 'visibility.raised', at: 0, to: 'private', reason: 'source', sources: ['wiki'] }]);
  const r = await run(['list'], home);
  assert.equal(r.code, 0, r.stderr);
  const row = (/** @type {string} */ id) => r.stdout.split('\n').find((l) => l.startsWith(id)) ?? '';
  // Visibility is the last column, so the earlier columns keep their places.
  assert.match(row('open-map'), / nodes {2}\d{4}-\S+ {2}public$/);
  assert.match(row('secret-map'), / nodes {2}\d{4}-\S+ {2}private$/);
  assert.equal(/private/.test(row('open-map')), false);
});

test('status: config path, ports and sources; broken config; no config is unchanged', async () => {
  const home = tmp();
  const before = await run(['status', '--home', home], home);
  const beforeJson = JSON.parse((await run(['status', '--json', '--home', home], home)).stdout);
  assert.equal(/Config|Ports|Sources/.test(before.stdout), false);
  assert.equal('config' in beforeJson, false);

  writeConfig(home, [stdioSource(), stdioSource({ name: 'docs', visibility: 'private' })]);
  await run(['token', 'create', '--name', 'a', '--sources', 'docs', '--home', home], home);
  const r = await run(['status', '--home', home], home);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Config: ${CONFIG(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(r.stdout, /^Ports: identity tokens, policy default, store files, model default$/m);
  assert.match(r.stdout, /^Sources: wiki \(public\), docs \(private\)$/m);
  assert.match(r.stdout, /^ {2}a {2}tenant default {2}scopes read,build {2}sources docs$/m);
  const j = JSON.parse((await run(['status', '--json', '--home', home], home)).stdout);
  assert.equal(j.config, CONFIG(home));
  assert.deepEqual(j.ports, { identity: 'tokens', policy: 'default', store: 'files', model: 'default' });
  assert.deepEqual(j.sources, [{ name: 'wiki', visibility: 'public' }, { name: 'docs', visibility: 'private' }]);
  assert.deepEqual(j.tokens[0].sources, ['docs']);

  fs.writeFileSync(CONFIG(home), 'export default { sourcez: [] };');
  const bad = await run(['status', '--home', home], home);
  assert.equal(bad.code, 0);
  assert.match(bad.stdout, /^Home: /m);
  assert.match(bad.stdout, new RegExp(`^Config .*ontologizer\\.config\\.js does not load: unknown key "sourcez"$`, 'm'));
  assert.equal(/^Ports:/m.test(bad.stdout), false);

  // planted: removing the config returns the exact pre-config output
  fs.rmSync(CONFIG(home));
  await run(['token', 'revoke', 'a', '--home', home], home);
  assert.equal((await run(['status', '--home', home], home)).stdout, before.stdout);
});

test('serve --config: unknown key, throwing import, valid config; never the cwd', async () => {
  const home = tmp();
  const unknown = path.join(home, 'unknown.js');
  fs.writeFileSync(unknown, 'export default { sourcez: [] };');
  const a = await run(['serve', '--config', unknown, '--port', '0', '--home', home, '--exit-after', '50'], home);
  assert.equal(a.code, 1);
  assert.ok(a.stderr.includes(unknown) && a.stderr.includes('unknown key'), a.stderr);
  assert.equal(/Serving/.test(a.stdout), false);

  const boom = path.join(home, 'boom.js');
  fs.writeFileSync(boom, 'throw new Error("kaboom");');
  const b = await run(['serve', '--config', boom, '--port', '0', '--home', home, '--exit-after', '50'], home);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /could not load/);
  assert.match(b.stderr, /kaboom/);

  const missing = await run(['serve', '--config', path.join(home, 'nope.js'), '--port', '0', '--home', home, '--exit-after', '50'], home);
  assert.equal(missing.code, 1);

  const good = path.join(home, 'good.js');
  fs.writeFileSync(good, `export default { sources: ${JSON.stringify([stdioSource()])} };\n`);
  const c = await run(['serve', '--config', good, '--port', '0', '--home', home, '--exit-after', '100'], home);
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stdout, /^Serving 0 maps at /m);
  assert.ok(c.stdout.split('\n').includes(`Config: ${good}`), c.stdout);

  // never the current folder: a config in the cwd, none given, none in the home
  const cwd = tmp(); const emptyHome = tmp();
  fs.writeFileSync(path.join(cwd, 'ontologizer.config.js'), 'export default { sourcez: [] };'); // would exit 1 if loaded
  const d = await run(['serve', '--port', '0', '--home', emptyHome, '--exit-after', '100'], emptyHome, {}, cwd);
  assert.equal(d.code, 0, d.stderr);
  assert.equal(/Config:/.test(d.stdout), false);
  // and the home's own file is found without --config
  fs.writeFileSync(CONFIG(emptyHome), 'export default {};');
  const e = await run(['serve', '--port', '0', '--home', emptyHome, '--exit-after', '100'], emptyHome, {}, cwd);
  assert.match(e.stdout, new RegExp(`^Config: ${CONFIG(emptyHome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('complete: the new flags', () => {
  assert.ok(complete(['serve', '--co']).includes('--config'));
});
