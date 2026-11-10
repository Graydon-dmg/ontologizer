// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// I5 · `ontologizer delete`, `trash` and `restore` on a temp home (the files store, as `save` and
// `list`). delete asks in a terminal and refuses without one unless --yes; it never deletes by prefix;
// it refuses a map a running one-map session serves (sessions.json). Each check has a planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { complete } from '../../src/cli/complete.js';
import { openStore, TRASH_ID_RE } from '../../src/core/store.js';
import { fixtureEvents } from './helpers-service.js';
import { faultyModule } from './helpers-fault.js';
import { makeDeps } from '../../src/cli/deps.js';

// Planted faults in the command itself (a broken copy of src/cli/commands/delete.js).
const FAULTS = {
  /** Never asks: deletes without a terminal and without --yes. */
  noQuestion: [['    if (!argv.yes) {\n', '    if (false) {\n']],
  /** Ignores sessions.json (the store's own guard still stops it, with the store's message). */
  noSessionCheck: [['    if (live && live.pid !== process.pid) {\n      throw new CliError(', '    if (false) {\n      throw new CliError(']],
  /** Ignores a running serve on the home. */
  noServeCheck: [['    if (server) throw new CliError(', '    if (false) throw new CliError(']],
};

/**
 * Run a broken copy of the delete command's handler, as main() would run the real one.
 * @param {Array<[string, string]>} fault @param {string} map @param {string} home @param {{ yes?: boolean }} [o]
 */
async function runBroken(fault, map, home, { yes = false } = {}) {
  const mod = await faultyModule('src/cli/commands/delete.js', fault);
  const stdout = cap(); const stderr = cap();
  const deps = makeDeps({ home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, prompts: /** @type {any} */ (async () => ({ confirm: async () => true })) });
  try {
    await mod.default.handler({ deps, map, yes });
    return { code: 0, stdout: stdout.out, stderr: stderr.out };
  } catch (/** @type {any} */ e) { return { code: e.code ?? 1, stdout: stdout.out, stderr: `${e.message}\n` }; }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-trash-cli-'));
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }

/**
 * @param {string[]} args @param {string} home
 * @param {{ interactive?: boolean, confirm?: boolean, asked?: string[] }} [o] confirm: the answer a terminal gives
 */
async function run(args, home, o = {}) {
  const stdout = cap(); const stderr = cap();
  const prompts = async () => ({ confirm: async (/** @type {any} */ q) => { o.asked?.push(q.message); return Boolean(o.confirm); } });
  const code = await main(args, {
    home, stdout, stderr, interactive: Boolean(o.interactive), prompts: /** @type {any} */ (prompts),
    env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {},
  });
  return { code, stdout: stdout.out, stderr: stderr.out };
}
/** @param {string} home */
const ids = (home) => openStore(home).list({ drafts: true }).map((/** @type {any} */ r) => r.id).sort();

/** Without a terminal and without --yes, nothing is deleted. @param {{ code: number, stderr: string }} r @param {string[]} left */
function noTerminalProblems(r, left) {
  /** @type {string[]} */ const p = [];
  if (r.code !== 1) p.push(`exit ${r.code}`);
  if (!/without a terminal to confirm: run it again with --yes/.test(r.stderr)) p.push(`message: ${r.stderr.trim()}`);
  if (!left.includes('demo')) p.push('the map was deleted anyway');
  return p;
}

test('delete without a terminal refuses unless --yes; in a terminal it asks, and no means no', async () => {
  const home = tmp();
  openStore(home).importEvents('demo', fixtureEvents('demo'));
  const r = await run(['delete', 'demo'], home);
  assert.deepEqual(noTerminalProblems(r, ids(home)), []);
  // Planted fault: a delete command that never asks.
  const broken = tmp();
  openStore(broken).importEvents('demo', fixtureEvents('demo'));
  assert.equal(noTerminalProblems(await runBroken(FAULTS.noQuestion, 'demo', broken), ids(broken)).length, 3);

  /** @type {string[]} */ const asked = [];
  const no = await run(['delete', 'demo'], home, { interactive: true, confirm: false, asked });
  assert.equal(no.code, 0);
  assert.match(no.stdout, /Not deleted/);
  assert.equal(asked[0], 'Delete demo? It goes to the trash and can be restored for 30 days.');
  assert.deepEqual(ids(home), ['demo']);
  const yes = await run(['delete', 'demo'], home, { interactive: true, confirm: true });
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual(ids(home), []);
});

test('delete --yes, trash, restore, a taken name, restore --as; never by prefix', async () => {
  const home = tmp();
  openStore(home).importEvents('demo', fixtureEvents('demo'));
  const prefix = await run(['delete', 'dem', '--yes'], home);
  assert.equal(prefix.code, 1);
  assert.match(prefix.stderr, /No map "dem"\. Did you mean:\n {2}demo/);
  assert.deepEqual(ids(home), ['demo']);

  const del = await run(['delete', 'demo', '--yes'], home);
  assert.equal(del.code, 0, del.stderr);
  const trashId = /ontologizer restore (\S+)/.exec(del.stdout)?.[1] ?? '';
  assert.ok(TRASH_ID_RE.test(trashId), del.stdout);
  assert.match(del.stdout, /Restore it within 30 days/);
  assert.deepEqual(ids(home), []);
  assert.match((await run(['list', '--drafts'], home)).stdout, /No saved maps yet/);

  const list = await run(['trash'], home);
  assert.match(list.stdout, new RegExp(`^${trashId} {2}.*82 nodes {2}public {2}deleted \\d{4}-\\d{2}-\\d{2} by local {2}purged after \\d{4}-\\d{2}-\\d{2}\\n`));
  const json = JSON.parse((await run(['trash', '--json'], home)).stdout);
  assert.equal(json[0].trashId, trashId);
  assert.equal(json[0].purgeAt - json[0].deletedAt, 30 * 24 * 60 * 60 * 1000);

  openStore(home).importEvents('demo', fixtureEvents('plastic-modeling')); // the name is taken again
  const taken = await run(['restore', trashId], home);
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /"demo" already exists: restore it under another name: add --as <name>\./);
  const as = await run(['restore', trashId, '--as', 'demo-old'], home);
  assert.equal(as.code, 0, as.stderr);
  assert.match(as.stdout, /^Restored demo-old\. Open it with: ontologizer load demo-old/);
  assert.deepEqual(ids(home), ['demo', 'demo-old']);
  assert.match((await run(['trash'], home)).stdout, /The trash is empty/);
  const missing = await run(['restore', trashId], home);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /is not in the trash/);
});

/** A map a running session serves is refused, and stays. @param {{ code: number, stderr: string }} r @param {string[]} left */
function servedProblems(r, left) {
  /** @type {string[]} */ const p = [];
  if (r.code !== 1) p.push(`exit ${r.code}`);
  if (!/is open in a running session \(port 4321\): stop it \(Ctrl-C there\), then delete it\./.test(r.stderr)) p.push(`message: ${r.stderr.trim()}`);
  if (!left.includes('demo')) p.push('a served map was deleted');
  return p;
}

test('delete refuses a map a running one-map session serves (sessions.json); a stale session does not block it', async () => {
  const home = tmp();
  const s = openStore(home);
  s.importEvents('demo', fixtureEvents('demo'));
  s.sessions.set('demo', { port: 4321, pid: process.ppid, startedAt: Date.now() }); // a live process that is not this one
  const r = await run(['delete', 'demo', '--yes'], home);
  assert.deepEqual(servedProblems(r, ids(home)), []);
  // Planted fault: a delete command that ignores sessions.json (the store's own guard still keeps the map;
  // the check reports the missing command-line message).
  const broken = await runBroken(FAULTS.noSessionCheck, 'demo', home, { yes: true });
  assert.deepEqual(servedProblems(broken, ids(home)).map((p) => p.split(':')[0]), ['message']);
  // A session whose process is gone is stale: it is cleaned up and the delete goes ahead.
  s.sessions.set('demo', { port: 4321, pid: 2 ** 22 + 12345, startedAt: Date.now() });
  const ok = await run(['delete', 'demo', '--yes'], home);
  assert.equal(ok.code, 0, ok.stderr);
});

test('completion: the new commands\' flags and map names; the pinned top-level list is unchanged', () => {
  const home = tmp();
  openStore(home).importEvents('demo', fixtureEvents('demo'));
  const prev = process.env.ONTOLOGIZER_HOME;
  process.env.ONTOLOGIZER_HOME = home;
  try {
    assert.deepEqual(complete(['delete', '--y']), ['--yes']);
    assert.deepEqual(complete(['restore', '--a']), ['--as']);
    assert.deepEqual(complete(['trash', '--j']), ['--json']);
    assert.deepEqual(complete(['delete', 'de']), ['demo']);
    assert.ok(!complete(['']).includes('delete'), 'top-level completion is pinned by test/b');
  } finally { if (prev === undefined) delete process.env.ONTOLOGIZER_HOME; else process.env.ONTOLOGIZER_HOME = prev; }
});

/** A map on a home where `serve` runs is refused, and stays. @param {{ code: number, stderr: string }} r @param {string[]} left @param {number} pid */
function serveRunningProblems(r, left, pid) {
  /** @type {string[]} */ const p = [];
  if (r.code !== 1) p.push(`exit ${r.code}`);
  const want = `A server is running on this home (pid ${pid}, http://127.0.0.1:8787/): delete from its page, or stop it first.`;
  if (r.stderr.trim() !== want) p.push(`message: ${r.stderr.trim()}`);
  if (!left.includes('demo')) p.push('the map was deleted under a running server');
  return p;
}

test('delete refuses while serve runs on the home (serve.json with a live pid); a stale serve.json does not block it', async () => {
  const home = tmp();
  openStore(home).importEvents('demo', fixtureEvents('demo'));
  const serveFile = path.join(home, 'serve.json');
  fs.writeFileSync(serveFile, JSON.stringify({ pid: process.ppid, url: 'http://127.0.0.1:8787/', startedAt: new Date().toISOString(), auth: 'open' }));
  const r = await run(['delete', 'demo', '--yes'], home);
  assert.deepEqual(serveRunningProblems(r, ids(home), process.ppid), []);
  // trash and restore still work: they only read, or add a map the server finds on its next request.
  assert.equal((await run(['trash'], home)).code, 0);
  // Planted fault: a delete command that ignores serve.json.
  const broken = await runBroken(FAULTS.noServeCheck, 'demo', home, { yes: true });
  assert.deepEqual(serveRunningProblems(broken, ids(home), process.ppid), [`exit 0`, `message: `, 'the map was deleted under a running server']);
  // A serve.json whose process is gone is stale: the delete goes ahead.
  openStore(home).importEvents('demo', fixtureEvents('demo'));
  fs.writeFileSync(serveFile, JSON.stringify({ pid: 2 ** 22 + 12345, url: 'http://127.0.0.1:8787/' }));
  const ok = await run(['delete', 'demo', '--yes'], home);
  assert.equal(ok.code, 0, ok.stderr);
});
