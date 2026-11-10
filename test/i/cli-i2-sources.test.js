// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { complete } from '../../src/cli/complete.js';

const STUB = new URL('./fixtures/stub-mcp.js', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-'));
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }

/** @param {string[]} args @param {string} home @param {Record<string,string>} [env] */
async function run(args, home, env = {}) {
  const stdout = cap(); const stderr = cap();
  const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home, ...env }, openBrowser: async () => {}, onSignal: () => () => {} });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

/** @param {string} home @param {any[]} sources */
function writeConfig(home, sources) {
  fs.writeFileSync(path.join(home, 'ontologizer.config.js'), `export default { sources: ${JSON.stringify(sources)} };\n`);
}
const stdio = (/** @type {any} */ over = {}) => ({ name: 'wiki', command: process.execPath, args: [STUB], visibility: 'public', allowTools: ['search', 'get', 'delete_page'], ...over });

test('sources list: text and json, against the stdio fixture', async () => {
  const home = tmp();
  writeConfig(home, [stdio(), stdio({ name: 'docs', visibility: 'private', allowTools: ['search'], args: [STUB, '--name', 'docs'] }), stdio({ name: 'gone', command: path.join(home, 'missing.js'), args: [] })]);
  const r = await run(['sources', 'list', '--home', home], home);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'wiki  public  tools search,get,delete_page  reachable');
  assert.equal(lines[1], 'docs  private  tools search  reachable');
  assert.match(lines[2], /^gone  public  tools .*  unreachable: ./);
  const j = JSON.parse((await run(['sources', 'list', '--json', '--home', home], home)).stdout);
  assert.deepEqual(j.map((/** @type {any} */ x) => [x.name, x.reachable]), [['wiki', true], ['docs', true], ['gone', false]]);
});

test('sources list: no config / no sources is a friendly exit 0', async () => {
  const home = tmp();
  const none = await run(['sources', 'list', '--home', home], home);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /^No sources configured\. Add a sources list to ontologizer\.config\.js/);
  fs.writeFileSync(path.join(home, 'ontologizer.config.js'), 'export default {};');
  assert.match((await run(['sources', 'list', '--home', home], home)).stdout, /No sources configured/);
});

test('sources test: offered and not offered lines; never calls a tool (planted: write tool in allowTools)', async () => {
  const home = tmp(); const log = path.join(home, 'calls.log');
  writeConfig(home, [stdio()]);
  const r = await run(['sources', 'test', 'wiki', '--home', home], home, { STUB_MCP_CALLS: log });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'wiki (public): reachable');
  assert.ok(lines.includes('  search  offered'));
  assert.ok(lines.includes('  get  offered'));
  assert.ok(lines.includes('  delete_page  not offered: not marked readOnlyHint'));
  assert.ok(lines.includes('  secret_search  not offered: not in allowTools'));
  assert.equal(fs.existsSync(log), false); // the stub writes this file if any tool is ever called
});

test('sources errors exit 1', async () => {
  const home = tmp();
  writeConfig(home, [stdio(), stdio({ name: 'gone', command: path.join(home, 'missing.js'), args: [] })]);
  const down = await run(['sources', 'test', 'gone', '--home', home], home);
  assert.equal(down.code, 1);
  assert.match(down.stderr, /gone: unreachable: /);
  const unk = await run(['sources', 'test', 'nope', '--home', home], home);
  assert.equal(unk.code, 1);
  assert.match(unk.stderr, /No source named "nope"\. Configured: wiki, gone\./);
  assert.equal((await run(['sources', '--home', home], home)).code, 1);
  assert.equal((await run(['sources', 'test', '--home', home], home)).code, 1);
  // a config that fails to validate
  fs.writeFileSync(path.join(home, 'ontologizer.config.js'), 'export default { sourcez: [] };');
  const bad = await run(['sources', 'list', '--home', home], home);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Config .*ontologizer\.config\.js: unknown key "sourcez"/);
  const missing = await run(['sources', 'list', '--config', path.join(home, 'x.js'), '--home', home], home);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not found/);
});

test('--config and ONTOLOGIZER_CONFIG are honored', async () => {
  const home = tmp(); const other = tmp(); const f = path.join(other, 'my.config.js');
  fs.writeFileSync(f, `export default { sources: [${JSON.stringify(stdio({ name: 'elsewhere' }))}] };`);
  assert.match((await run(['sources', 'list', '--config', f, '--home', home], home)).stdout, /^elsewhere  public/);
  assert.match((await run(['sources', 'list', '--home', home], home, { ONTOLOGIZER_CONFIG: f })).stdout, /^elsewhere  public/);
});

test('completion: sources subcommands and flags; top-level list unchanged', () => {
  assert.deepEqual(complete(['sources', '']), ['list', 'test']);
  assert.deepEqual(complete(['sources', 't']), ['test']);
  assert.deepEqual(complete(['sources', '--c']), ['--config']);
  assert.ok(!complete(['']).includes('sources'));
});
