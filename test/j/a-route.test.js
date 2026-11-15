// @ts-check
// Epic A: POST /v1/t/default/maps/organize. Validation before any draft, the stub run's result,
// durable-before-202, the daily limit, a failed run, metering with the real engine, the time limit.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, req, stubEngine, tempHome } from '../i/helpers-service.js';
import { startService } from '../../src/server/service.js';
import { createUsage } from '../../src/server/usage.js';
import { createEngine } from '../../src/core/engine/index.js';
import { openStore } from '../../src/core/store.js';
import { organizeTimeout } from '../../src/server/organize.js';
import { createFakeClient, lines } from '../c/fake.js';

const ORG = '/v1/t/default/maps/organize';
const MIN = 60 * 1000;
const sample = /** @type {any[]} */ (JSON.parse(fs.readFileSync(new URL('./fixtures/items/sample-120.json', import.meta.url), 'utf8')));
const post = (/** @type {string} */ url, /** @type {any} */ body) => req(url, ORG, { method: 'POST', body, headers: { accept: 'application/json' } });
const drafts = (/** @type {string} */ home) => openStore(home).list({ drafts: true }).length;
const wait = async (/** @type {string} */ url, /** @type {string} */ id) =>
  /** @type {any} */ (JSON.parse((await req(url, `/v1/t/default/maps/${id}/wait?timeout=20000`, { headers: { accept: 'application/json' } })).body));
const gen = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));

test('validation: each bad body is 400 with the exact error and creates no draft; 500 human items pass', async () => {
  const { srv, home } = await boot();
  try {
    const cases = /** @type {Array<[any, string]>} */ ([
      [{ name: 'x', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, 'duplicate ids: a, b'],
      [{ name: 'x', items: [{ id: 'constructor', label: 'C' }] }, 'item 0: "constructor" is a reserved name'],
      [{ name: 'x', items: gen(10001) }, 'items must be a list of 1 to 10000 items'],
      [{ name: 'x', mode: 'human', items: gen(501) }, 'items must be a list of 1 to 500 items'],
      [{}, 'give name and items'],
    ]);
    const before = drafts(home);
    for (const [body, error] of cases) {
      const r = await post(srv.url, body);
      assert.equal(r.status, 400, error);
      assert.equal(r.json().error, error);
      assert.equal(drafts(home), before, `${error}: no draft`);
    }
    // planted fault (off by one): the cap is 500, so exactly 500 must pass
    const ok = await post(srv.url, { name: 'x', mode: 'human', items: gen(500) });
    assert.equal(ok.status, 202, ok.body);
    await wait(srv.url, ok.json().id);
  } finally { await srv.close(); }
});

test('success under the stub engine: every id once as a childless leaf, no childless family, mode and view set', async () => {
  const { srv, home } = await boot();
  try {
    for (const human of [false, true]) {
      const r = await post(srv.url, { name: 'sample', items: sample, ...(human ? { mode: 'human' } : {}) });
      assert.equal(r.status, 202, r.body);
      const { id, viewUrl, eventsUrl } = r.json();
      assert.ok(id && viewUrl.endsWith(`/maps/${id}/view`), viewUrl);
      assert.ok(eventsUrl.endsWith(`/maps/${id}/events`), eventsUrl);
      const w = await wait(srv.url, id);
      assert.equal(w.state, 'idle', JSON.stringify(w));
      assert.equal(w.error, undefined);
      const map = /** @type {any} */ (openStore(home).read(id));
      const nodes = Object.values(map.nodes);
      const ids = new Set(sample.map((s) => s.id));
      const hasKid = new Set(nodes.map((n) => /** @type {any} */ (n).parent));
      const leaves = nodes.filter((n) => ids.has(/** @type {any} */ (n).id));
      assert.equal(leaves.length, sample.length, 'every input id exactly once');
      assert.ok(leaves.every((n) => !hasKid.has(/** @type {any} */ (n).id)), 'leaves are childless');
      const empty = nodes.filter((n) => /** @type {any} */ (n).id.startsWith('_root') && /** @type {any} */ (n).id !== '_root' && !hasKid.has(/** @type {any} */ (n).id));
      assert.deepEqual(empty.map((n) => /** @type {any} */ (n).id), [], 'no childless family');
      assert.equal(map.mode, human ? 'human' : 'agent');
      assert.equal(map.view.filter.maxDepth, human ? null : 2);
    }
  } finally { await srv.close(); }
});

/** A service on a config store whose sync can be made to fail; the engine's organize records its calls. */
async function wrapped(/** @type {{ failSync?: boolean, organize?: any, usage?: any }} */ o = {}) {
  const home = tempHome();
  const real = openStore(home);
  const store = new Proxy(real, {
    get(t, k) {
      if (k === 'sync' && o.failSync) return () => Promise.reject(new Error('store down'));
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  /** @type {any[]} */
  const calls = [];
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, allowHosts: [], maxBuilds: 2, version: 'test', tokensFile: null, config: { store: () => store },
    ...(o.usage ? { usage: o.usage(home) } : {}),
    makeEngine: async (/** @type {any} */ x) => ({ ...stubEngine(x), organize: (/** @type {any} */ i) => { calls.push(i); return o.organize ? o.organize(i, x) : Promise.resolve({ items: 0, families: 0, unsorted: 0 }); } }),
  });
  return { home, real, srv, calls };
}

test('durable before 202: a failing sync is 503 and no run starts', async () => {
  const bad = await wrapped({ failSync: true });
  const good = await wrapped();
  try {
    const body = { name: 'x', items: [{ id: 'a', label: 'A' }] };
    const r = await post(bad.srv.url, body);
    assert.equal(r.status, 503, r.body);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(bad.calls.length, 0, 'organize never called');
    // planted fault: with a working sync the same request does start a run
    const g = await post(good.srv.url, body);
    assert.equal(g.status, 202);
    await wait(good.srv.url, g.json().id);
    assert.equal(good.calls.length, 1);
  } finally { await bad.srv.close(); await good.srv.close(); }
});

test('the daily limit answers 429 before any draft', async () => {
  const mk = (/** @type {number} */ prior) => wrapped({ usage: (/** @type {string} */ home) => { const u = createUsage({ home, limitCalls: 1 }); if (prior) u.record('default', { calls: prior }); return u; } });
  const full = await mk(1);
  const fresh = await mk(0);
  try {
    const body = { name: 'x', items: [{ id: 'a', label: 'A' }] };
    const r = await post(full.srv.url, body);
    assert.equal(r.status, 429, r.body);
    assert.equal(drafts(full.home), 0, 'no draft');
    assert.equal(full.calls.length, 0);
    // planted fault: under the limit the same body is accepted (so the 429 is the limit's doing)
    assert.equal((await post(fresh.srv.url, body)).status, 202);
  } finally { await full.srv.close(); await fresh.srv.close(); }
});

test('a failing run: job.failed with kind organize and the error, wait reports it, the draft stays', async () => {
  const MSG = 'organize: the model did not return a valid family tree';
  const s = await wrapped({ organize: () => Promise.reject(new Error(MSG)) });
  try {
    const r = await post(s.srv.url, { name: 'x', items: [{ id: 'a', label: 'A' }] });
    assert.equal(r.status, 202);
    const { id } = r.json();
    const w = await wait(s.srv.url, id);
    assert.equal(w.state, 'idle');
    assert.equal(w.error, MSG, JSON.stringify(w));
    const ev = /** @type {any[]} */ ([]);
    for await (const e of s.real.events(id)) ev.push(e);
    const f = ev.find((e) => e.t === 'job.failed');
    assert.ok(f, 'a job.failed event');
    assert.equal(f.job.kind, 'organize');
    assert.equal(f.job.error, MSG);
    assert.ok(s.real.read(id), 'the draft still reads');
    assert.equal(drafts(s.home), 1, 'the draft is not deleted');
  } finally { await s.srv.close(); }
});

/** A depth-3 tree (4 tops x 2) as the families call answers; placement spreads items over the 8 deepest. */
function answer(/** @type {any} */ params) {
  const sys = JSON.stringify(params.system ?? '');
  if (/Place each item/.test(sys)) {
    const items = String(params.messages[0].content).split(/Items \(\d+\):\n/)[1].split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const fams = String(params.messages[0].content).split('Families:\n')[1].split('\n\n')[0].split('\n').map((l) => JSON.parse(l));
    return { text: lines(items.map((it, i) => ({ id: it.id, family: fams[i % fams.length].key }))) };
  }
  const tree = [];
  for (let t = 0; t < 4; t++) {
    tree.push({ key: `t${t}`, label: `Top ${t}`, parent: 'ROOT', description: 'top' });
    for (let c = 0; c < 2; c++) tree.push({ key: `t${t}c${c}`, label: `Child ${t} ${c}`, parent: `t${t}`, description: 'child' });
  }
  return { text: lines(tree) };
}

test('metering with the real engine and a fake model: 450 items count 1 + ceil(450/200) = 4 calls', async () => {
  const home = tempHome();
  const fake = createFakeClient({ chunkMs: 0, respond: (params) => answer(params) });
  const usage = createUsage({ home, limitCalls: null });
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, allowHosts: [], maxBuilds: 2, version: 'test', tokensFile: null, usage,
    makeEngine: async (/** @type {any} */ x) => createEngine({ store: x.store, id: x.id, client: x.meter(fake), models: { fast: 'fast-model', strong: 'strong-model' } }),
  });
  try {
    // planted fault: the counter is 0 before the run (so a pass is not a stale count)
    assert.equal(usage.today('default').calls, 0);
    const r = await post(srv.url, { name: 'big', items: gen(450) });
    assert.equal(r.status, 202, r.body);
    const w = await wait(srv.url, r.json().id);
    assert.equal(w.error, undefined, JSON.stringify(w));
    const map = /** @type {any} */ (openStore(home).read(r.json().id));
    const leaves = Object.keys(map.nodes).filter((k) => /^i\d+$/.test(k));
    assert.equal(leaves.length, 450);
    assert.equal(fake.calls.length, 4);
    assert.equal(usage.today('default').calls, 4);
  } finally { await srv.close(); }
});

test('organizeTimeout: 15 min + 2 per 1,000 items, capped at 45, never under the operator limit', () => {
  assert.equal(organizeTimeout(120, 0), 17 * MIN);
  assert.equal(organizeTimeout(10000, 0), 35 * MIN);
  assert.equal(organizeTimeout(20000, 0), 45 * MIN);
  assert.equal(organizeTimeout(120, 60 * MIN), 60 * MIN);
  assert.equal(organizeTimeout(20000, 60 * MIN), 60 * MIN);
});
