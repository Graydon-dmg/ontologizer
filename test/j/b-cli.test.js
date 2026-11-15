// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// B4: the stub's deterministic hydrate and `ontologizer hydrate` on the local stub engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/core/store.js';
import { main } from '../../src/cli/main.js';
import { stubHydrate } from '../../src/cli/engine-stub-hydrate.js';
import { createMemoryStore } from '../c/fake.js';
import { tempHome, fixtureEvents } from '../i/helpers-service.js';

const P = 'plastic-modeling';

/** @param {string} home */
function cli(home) {
  const cap = () => ({ out: '', write(/** @type {string} */ x) { this.out += x; return true; } });
  return async (/** @type {string[]} */ args) => {
    const stdout = cap(); const stderr = cap();
    const code = await main(args, { home, stdout, stderr, interactive: false, keyring: { get: () => null, set() {}, delete: () => false },
      openBrowser: async () => {}, onSignal: () => () => {}, env: { ...process.env, ONTOLOGIZER_HOME: home, ONTOLOGIZER_STUB_SPEED: '1000', ANTHROPIC_API_KEY: 'sk-ant-test-0000' } });
    return { code, stdout: stdout.out, stderr: stderr.out };
  };
}

test('stub: a deterministic hydration per node, the first other sibling as look-alike; none for an only child', () => {
  const store = createMemoryStore();
  store.append('m', { t: 'ontology.created', at: 0, name: 'm', root: 'r', brief: {}, categories: [] });
  for (const [id, label, parent] of [['r', 'R', null], ['a', 'Apple', 'r'], ['b', 'banana', 'r'], ['c', 'Cherry', 'r'], ['a1', 'Only', 'a']]) {
    store.append('m', { t: 'node.added', at: 1, node: { id, label, parent } });
  }
  /** @type {any[]} */ const out = [];
  stubHydrate({ store, id: 'm', job: { nodeIds: ['b', 'a1', 'constructor'] }, emit: (t, f) => out.push({ t, ...f }) });
  assert.deepEqual(out, [
    { t: 'node.hydrated', nodeId: 'b', hydration: { job: 'Stub job for banana', examples: ['banana example 1', 'banana example 2', 'banana example 3'],
      not_for: 'Not Apple.', not_for_ids: ['a'], model: 'stub', at: '2026-01-01T00:00:00.000Z' } },
    { t: 'node.hydrated', nodeId: 'a1', hydration: { job: 'Stub job for Only', examples: ['Only example 1', 'Only example 2', 'Only example 3'],
      not_for: '', not_for_ids: [], model: 'stub', at: '2026-01-01T00:00:00.000Z' } },
  ]);
});

test('CLI: hydrate --all prints the plan, each batch and the total; a second run skips; --nodes validates first', async () => {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents(P, fixtureEvents(P));
  store.flush?.();
  const run = cli(home);
  const n = Object.keys(store.read(P).nodes).length - 1;

  const first = await run(['hydrate', P, '--all']);
  assert.equal(first.code, 0, first.stderr);
  const b = Number(/^(\d+) batches, about \1 calls$/m.exec(first.stdout)?.[1]);
  assert.ok(b > 1, first.stdout);
  assert.equal((first.stdout.match(/^batch \d+ \(.+\): done$/gm) ?? []).length, b);
  assert.match(first.stdout, new RegExp(`^Hydrated ${n} of ${n} nodes$`, 'm'));
  const o = openStore(home).read(P);
  assert.ok(Object.values(o.nodes).every((/** @type {any} */ x) => x.id === o.root ? !x.hydration : x.hydration?.model === 'stub'));

  const again = await run(['hydrate', P, '--all']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`^Skipped ${n} \\(already hydrated\\)`, 'm'));
  assert.match(again.stdout, /^0 batches, about 0 calls$/m);

  const redo = await run(['hydrate', P, '--nodes', `${P}/tools`, '--redo', '--model', 'haiku']);
  assert.equal(redo.code, 0, redo.stderr);
  assert.match(redo.stdout, /^Hydrated 1 of 1 nodes$/m);

  for (const [args, error] of [[['--nodes', 'constructor'], 'no node "constructor": nothing was started'],
    [[], 'give nodeIds or all'], [['--all', '--nodes', `${P}/tools`], 'give nodeIds or all, not both'],
    [['--nodes', P], 'the root has nothing to compare with: leave it out']]) {
    const r = await run(['hydrate', P, ...args]);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, new RegExp(error.replace(/[()]/g, '\\$&')));
  }
});

test('CLI: refuses with exit 1 while a server runs on the home', async () => {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents(P, fixtureEvents(P));
  store.sessions.addServer({ pid: process.ppid, url: 'http://127.0.0.1:1' });
  store.flush?.();
  const r = await cli(home)(['hydrate', P, '--all']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /A server is running on this home/);
  assert.equal(Object.values(openStore(home).read(P).nodes).filter((/** @type {any} */ x) => x.hydration).length, 0);
});

test('CLI: a failing batch exits 1 and lists every failed id (real engine, a model server that refuses)', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fake model refuses' } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  const home = tempHome();
  const store = openStore(home);
  store.importEvents(P, fixtureEvents(P));
  store.flush?.();
  const cap = () => ({ out: '', write(/** @type {string} */ x) { this.out += x; return true; } });
  const stdout = cap(); const stderr = cap();
  const port = /** @type {any} */ (srv.address()).port;
  const ids = [`${P}/tools`, `${P}/kits`];
  try {
    const code = await main(['hydrate', P, '--nodes', ids.join(',')], { home, stdout, stderr, interactive: false,
      keyring: { get: () => null, set() {}, delete: () => false }, openBrowser: async () => {}, onSignal: () => () => {},
      env: { ...process.env, ONTOLOGIZER_HOME: home, ONTOLOGIZER_ENGINE: 'real', ANTHROPIC_API_KEY: 'sk-ant-test-0000', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
    assert.equal(code, 1, stdout.out + stderr.out);
    assert.match(stdout.out, /^batch 1 \(plastic-modeling, 2 nodes\): (?!done).+$/m);
    assert.match(stdout.out, /^Hydrated 0 of 2 nodes$/m);
    assert.match(stderr.out, new RegExp(`Failed: ${ids.slice().sort().join(', ')}|Failed: ${ids.join(', ')}`));
    assert.equal(Object.values(openStore(home).read(P).nodes).filter((/** @type {any} */ x) => x.hydration).length, 0);
  } finally { srv.close(); }
});

test('CLI: the stub path needs no key: organize sample-120, then hydrate --all → exit 0, every node hydrated', async () => {
  const home = tempHome();
  const cap = () => ({ out: '', write(/** @type {string} */ x) { this.out += x; return true; } });
  const env = { ...process.env, ONTOLOGIZER_HOME: home, ONTOLOGIZER_ENGINE: 'stub', ONTOLOGIZER_STUB_SPEED: '1000' };
  delete env.ANTHROPIC_API_KEY;
  const run = async (/** @type {string[]} */ args) => {
    const stdout = cap(); const stderr = cap();
    const code = await main(args, { home, stdout, stderr, interactive: false, keyring: { get: () => null, set() {}, delete: () => false },
      openBrowser: async () => {}, onSignal: () => () => {}, env });
    return { code, stdout: stdout.out, stderr: stderr.out };
  };
  const items = new URL('./fixtures/items/sample-120.json', import.meta.url).pathname;
  const org = await run(['organize', items, '--name', 's', '--home', home]);
  assert.equal(org.code, 0, org.stdout + org.stderr);
  const id = /: (\S+?)(?:\s|$)/.exec(/^Organised .*$/m.exec(org.stdout)?.[0] ?? '')?.[1];
  assert.ok(id, org.stdout);
  // planted fault: needKey: true under the stub stops here with "No Anthropic API key"
  const h = await run(['hydrate', /** @type {string} */ (id), '--all', '--home', home]);
  assert.equal(h.code, 0, h.stdout + h.stderr);
  assert.doesNotMatch(h.stderr, /API key/);
  const o = openStore(home).read(/** @type {string} */ (id));
  const nodes = Object.values(o.nodes).filter((/** @type {any} */ x) => x.id !== o.root);
  assert.ok(nodes.length > 120);
  assert.ok(nodes.every((/** @type {any} */ x) => x.hydration?.model === 'stub'));
  assert.match(h.stdout, new RegExp(`^Hydrated ${nodes.length} of ${nodes.length} nodes$`, 'm'));
});
