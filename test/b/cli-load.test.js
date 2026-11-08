// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { main } from '../../src/cli/main.js';
import { openStore } from '../../src/core/store.js';
import { resolveNode } from '../../src/cli/resolve-name.js';
import { tempHome, fixtureEvents } from './helpers.js';

const KEY = 'sk-ant-test-0000';
function cap() { return { out: '', write(/** @type {string} */ s) { this.out += s; return true; } }; }
const fakeKeyring = () => ({ v: null, get() { return this.v; }, set(/** @type {any} */ k) { this.v = k; }, delete() { const had = this.v != null; this.v = null; return had; } });

/** @param {string} home @param {string[]} args @param {any} [over] */
async function run(home, args, over = {}) {
  const stdout = cap(); const stderr = cap();
  const env = { ...process.env, ONTOLOGIZER_HOME: home, ONTOLOGIZER_STUB_SPEED: '1000', ...(over.env || {}) };
  const code = await main(args, {
    home, stdout, stderr, interactive: false, keyring: fakeKeyring(), openBrowser: async () => {},
    onSignal: () => () => {}, ...over, env,
  });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

/** @param {string} home */
function seeded(home) {
  const store = openStore(home);
  store.importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  store.importEvents('manga', fixtureEvents('manga'));
  return store;
}

test('load imports the bundled fixture on an empty store and serves it', async () => {
  const home = tempHome();
  const r = await run(home, ['load', 'plastic-modeling', '--no-open', '--exit-after', '300']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Imported the bundled "plastic-modeling" map/);
  assert.match(r.stdout, /Serving /);
  const row = openStore(home).list().find((x) => x.id === 'plastic-modeling');
  assert.ok(row && !row.draft);
  const want = Object.keys((await import('../../src/core/events.js')).foldAll(fixtureEvents('plastic-modeling')).nodes).length;
  assert.equal(row.nodes, want);
  // fault: a name that is not a bundled fixture must not invent a map
  const bad = await run(home, ['load', 'nonexistent-map', '--no-open', '--exit-after', '50']);
  assert.equal(bad.code, 1);
  assert.doesNotMatch(bad.stdout, /Serving/);
});

test('ambiguous prefix, not interactive: exit 1, lists both, does not serve', async () => {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('manga', fixtureEvents('manga'));
  store.importEvents('modeling', fixtureEvents('plastic-modeling'));
  const r = await run(home, ['load', 'm', '--no-open', '--exit-after', '100']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /manga/i);
  assert.match(r.stderr, /modeling/i);
  assert.doesNotMatch(r.stdout, /Serving/);
});

test('load never prompts for a key, even interactive', async () => {
  const home = tempHome();
  seeded(home);
  const r = await run(home, ['load', 'manga', '--no-open', '--exit-after', '100'], {
    interactive: true,
    ask: async () => { throw new Error('ask was called'); },
    prompts: async () => { throw new Error('prompt opened'); },
  });
  assert.equal(r.code, 0, r.stderr);
});

test('fuse and rosetta print the engine error verbatim and exit 1, with no model call', async () => {
  const home = tempHome();
  seeded(home);
  const env = { ANTHROPIC_API_KEY: KEY };
  const f = await run(home, ['fuse', 'plastic-modeling', 'manga', '--no-open', '--exit-after', '50'], { env });
  assert.equal(f.code, 1, f.stdout + f.stderr);
  // Epic G's fuse is real now; under the stub its model call is refused offline, and the CLI
  // must print that engine message as is (the same path that printed "fuse: not built yet").
  assert.match(f.stderr, /stub engine: no model calls|not built yet/);
  const ro = await run(home, ['rosetta', 'manga', '--as', 'a home chef', '--no-open', '--exit-after', '50'], { env });
  assert.equal(ro.code, 1, ro.stdout + ro.stderr);
  assert.match(ro.stderr, /stub engine: no model calls|not built yet/);
  // fault: success path must not have been printed
  assert.doesNotMatch(f.stdout, /Fused into/);
  assert.doesNotMatch(ro.stdout, /added\./);
});

test('explain headless via the stub appends job.done for the suffix-resolved node', async () => {
  const home = tempHome();
  seeded(home);
  const r = await run(home, ['explain', 'plastic-modeling', 'adhesives'], { env: { ANTHROPIC_API_KEY: KEY } });
  assert.equal(r.code, 0, r.stderr);
  const events = [];
  for await (const e of openStore(home).events('plastic-modeling')) events.push(e);
  assert.ok(events.some((e) => e.t === 'job.done' && e.job.nodeId === 'plastic-modeling/tools/adhesives'));
});

test('resolveNode: id suffix, label, and a miss throws', () => {
  const onto = openStore(tempHomeWith()).read('plastic-modeling');
  assert.equal(resolveNode(onto, 'adhesives'), 'plastic-modeling/tools/adhesives');
  assert.equal(resolveNode(onto, 'ADHESIVES'), 'plastic-modeling/tools/adhesives');
  assert.throws(() => resolveNode(onto, 'nope'), /nope/);
});
function tempHomeWith() { const h = tempHome(); seeded(h); return h; }

test('explain with a live session posts to it instead of running', async () => {
  const home = tempHome();
  const store = seeded(home);
  /** @type {any[]} */
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push(JSON.parse(b)); res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"ok":true,"jobId":"j1"}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (srv.address()).port;
  store.sessions.set('plastic-modeling', { port, pid: process.pid, startedAt: Date.now() });
  try {
    // no key anywhere: proves the live path does not need an engine
    const r = await run(home, ['explain', 'plastic-modeling', 'adhesives'], { fetch: globalThis.fetch });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(got, [{ type: 'explain', nodeId: 'plastic-modeling/tools/adhesives' }]);
    assert.match(r.stdout, /Sent to the open session \(job j1\)/);
  } finally {
    srv.close();
  }
});

test('fuse with a third map is refused with the contract message, before any key prompt', async () => {
  const home = tempHome();
  seeded(home);
  let asked = 0;
  const ask = async () => { asked++; return 'sk-ant-test-0000'; };
  const r = await run(home, ['fuse', 'plastic-modeling', 'manga', 'plastic-modeling', '--no-open', '--exit-after', '50'],
    { interactive: true, ask });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'fuse takes two maps; fuse the result again to add a third\n');
  assert.equal(asked, 0, 'asked for a key before refusing');
  // Planted fault: without the [more..] positional, yargs' own "Unknown argument" message comes out instead.
  const { default: yargs } = await import('yargs');
  let msg = '';
  await yargs(['fuse', 'a', 'b', 'c']).command('fuse <a> <b>', '', () => {}, () => {}).strict()
    .exitProcess(false).fail((m) => { msg = m; }).parseAsync().catch(() => {});
  assert.match(msg, /Unknown argument/);
  assert.notEqual(msg, 'fuse takes two maps; fuse the result again to add a third');
});

test('an unknown flag exits 1 before the command runs (no server); --port serves on that port', async () => {
  const home = tempHome();
  seeded(home);
  const bad = await run(home, ['load', 'plastic-modeling', '--bogus', '1', '--no-open', '--exit-after', '50']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown argument: bogus/);
  // Planted fault: the old behaviour printed the error AND served the map.
  assert.doesNotMatch(bad.stdout, /Serving/);

  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = /** @type {any} */ (s.address()).port; s.close(() => resolve(p)); });
  });
  const ok = await run(home, ['load', 'plastic-modeling', '--port', String(port), '--no-open', '--exit-after', '50']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));

  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const busy = await run(home, ['load', 'plastic-modeling', '--port', String(port), '--no-open', '--exit-after', '50']);
  blocker.close();
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /already in use/);
  for (const p of ['80', '70000', 'abc', '1.5']) {
    const r = await run(home, ['load', 'plastic-modeling', '--port', p, '--no-open', '--exit-after', '50']);
    assert.equal(r.code, 1, p);
  }
});
