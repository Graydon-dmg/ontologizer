// @ts-check
// Service mode, review fixes: a fusing draft is busy, no orphan handlers, a map being saved takes no
// writes, the check engine's key is never a map id, a legacy map named `tenants`, status across
// tenants, and the wider proxy-header list.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '1000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, req, seed, stubEngine, tempHome, fixtureEvents } from './helpers-service.js';
import { openStore } from '../../src/core/store.js';
import { PROXY_HEADERS } from '../../src/server/service.js';
import { main } from '../../src/cli/main.js';

/** @param {string} s */
const bearer = (s) => ({ authorization: `Bearer ${s}` });
const MAP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** A gate: `open` lets whatever awaits `wait` go on. */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  const wait = new Promise((r) => { open = () => r(undefined); });
  return { wait, open };
}

test('a fused draft is busy while the fuse still writes into it: save is 409 and wait says busy', async () => {
  const g = gate();
  const gated = (/** @type {any} */ x) => ({
    ...stubEngine(x),
    async fuse(/** @type {string} */ _a, /** @type {string} */ _b, /** @type {any} */ opts) {
      const d = x.store.createDraft({ context: 'fused' }, 'fused');
      x.store.append(d, { t: 'ontology.created', at: 0, name: 'fused', root: 'fused', brief: {}, categories: [] });
      opts.onDraft?.(d);
      await g.wait; // still writing
      x.store.append(d, { t: 'category.added', at: 1, category: { id: 'late', label: 'Late', index: 0 } });
      return d;
    },
  });
  const { srv, home } = await boot({ makeEngine: async (/** @type {any} */ x) => gated(x) });
  try {
    await seed(home, 'default', 'plastic-modeling');
    await seed(home, 'default', 'manga', 'manga');
    const f = await req(srv.url, '/v1/t/default/maps/plastic-modeling/actions', { method: 'POST', body: { type: 'fuse', with: 'manga' } });
    assert.equal(f.status, 202);
    const d = f.json().draftId;
    assert.ok(d);
    const w = (await req(srv.url, `/v1/t/default/maps/${d}/wait?timeout=0`)).json();
    assert.equal(w.state, 'busy');
    assert.ok(w.jobs.some((/** @type {any} */ j) => j.kind === 'fuse'));
    assert.equal((await req(srv.url, `/v1/t/default/maps/${d}/save`, { method: 'POST', body: { name: 'early' } })).status, 409);
    g.open();
    assert.equal((await req(srv.url, `/v1/t/default/maps/${d}/wait?timeout=5000`)).json().state, 'idle');
    assert.equal((await req(srv.url, `/v1/t/default/maps/${d}/save`, { method: 'POST', body: { name: 'gunpla' } })).status, 200);
    // The late write landed in the saved map, not a stray old id.
    assert.ok(openStore(home).read('gunpla').categories.some((/** @type {any} */ c) => c.id === 'late'));
  } finally { g.open(); await srv.close(); }
});

/** A stub engine whose first creation for `id` waits on a gate. @param {string} id @param {Promise<any>} wait */
function slowFirstEngine(id, wait) {
  let first = true;
  return async (/** @type {any} */ x) => {
    if (x.id === id && first) { first = false; await wait; }
    return stubEngine(x);
  };
}

test('a handler dropped (map saved) while it was being made is never used; a map being saved takes no writes', async () => {
  const g = gate();
  const { srv, home } = await boot({ makeEngine: slowFirstEngine('m1', g.wait) });
  try {
    await seed(home, 'default', 'm1');
    // A stream starts making m1's handler (its engine is slow), then save drops it.
    const stream = req(srv.url, '/v1/t/default/maps/m1/snapshot');
    await new Promise((r) => setTimeout(r, 50));
    const save = req(srv.url, '/v1/t/default/maps/m1/save', { method: 'POST', body: { name: 'm2' } });
    await new Promise((r) => setTimeout(r, 50));
    // While m1 is saving, an action on the old id is refused (it would make a new handler and write there).
    const act = await req(srv.url, '/v1/t/default/maps/m1/actions', { method: 'POST', body: { type: 'focus', nodeId: 'x' } });
    assert.equal(act.status, 409, act.body);
    g.open();
    const s = await stream;
    // The orphan handler (made for m1 after the drop) answers nothing: the map is saving or gone.
    assert.ok(s.status === 409 || s.status === 404, `the orphan answered ${s.status}`);
    assert.equal((await save).status, 200);
    assert.equal(srv.stats().handlers, 0);
    assert.ok(!fs.existsSync(path.join(home, 'm1')), 'nothing was written to the old id');
    assert.equal((await req(srv.url, '/v1/t/default/maps/m2/snapshot')).status, 200);
  } finally { g.open(); await srv.close(); }
});

test("the context check's engine key is never a map id, so a map named draft-pending gets its own engine", async () => {
  /** @type {string[]} */
  const made = [];
  const { srv, home } = await boot({ makeEngine: async (/** @type {any} */ x) => { made.push(x.id); return stubEngine(x); } });
  try {
    await seed(home, 'default', 'draft-pending');
    assert.equal((await req(srv.url, '/v1/t/default/maps/check', { method: 'POST', body: { context: 'kits' } })).status, 200);
    assert.equal((await req(srv.url, '/v1/t/default/maps/draft-pending/snapshot')).status, 200);
    assert.equal(made.length, 2, made.join(','));
    assert.equal(made.filter((id) => MAP_ID_RE.test(id)).length, 1, `a check key that is a valid map id: ${made.join(',')}`);
  } finally { await srv.close(); }
});

/** A home with a map saved as `tenants` before the name was reserved. */
function legacyTenantsHome() {
  const home = tempHome();
  const store = openStore(home);
  store.importEvents('legacy', fixtureEvents('plastic-modeling'));
  fs.renameSync(path.join(home, 'legacy'), path.join(home, 'tenants'));
  const idx = JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8'));
  for (const r of idx.ontologies) if (r.id === 'legacy') { r.id = 'tenants'; r.name = 'tenants'; }
  fs.writeFileSync(path.join(home, 'index.json'), JSON.stringify(idx));
  return home;
}

test('a legacy map named tenants stays a map: no tenants are read from it, nothing is written in it, serve and status warn', async () => {
  const home = legacyTenantsHome();
  const before = fs.readdirSync(path.join(home, 'tenants')).sort();
  assert.throws(() => openStore(home, { tenant: 'acme' }), /a map named 'tenants' exists/);
  /** @type {string[]} */
  const logs = [];
  const { srv } = await boot({ home, log: (l) => logs.push(l) });
  try {
    assert.ok(logs.some((l) => l.includes("a map named 'tenants' exists; rename it to use multiple tenants")), logs.join('\n'));
    assert.equal((await req(srv.url, '/v1/t/acme/maps', { method: 'POST', body: { brief: { context: 'x' } } })).status, 404);
    assert.equal((await req(srv.url, '/v1/t/acme/status')).status, 404);
    assert.equal((await req(srv.url, '/v1/t/default/maps/tenants/snapshot')).status, 200);
  } finally { await srv.close(); }
  assert.deepEqual(fs.readdirSync(path.join(home, 'tenants')).sort(), before, 'something was written inside the map');
  const out = { s: '', write(/** @type {string} */ c) { this.s += c; return true; } };
  const err = { s: '', write(/** @type {string} */ c) { this.s += c; return true; } };
  const code = await main(['status', '--json', '--home', home], { home, stdout: out, stderr: err, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home }, openBrowser: async () => {}, onSignal: () => () => {} });
  assert.equal(code, 0, err.s);
  assert.deepEqual(JSON.parse(out.s).tenants, [{ tenant: 'default', maps: 1 }]);
  assert.match(err.s, /a map named 'tenants' exists; rename it to use multiple tenants/);
});

test("status: an admin token reads only its own tenant's status, unless it is an admin of tenant default", async () => {
  const { srv, secrets } = await boot({ tokens: [
    { name: 'root', scopes: ['admin'] }, { name: 'acme-admin', tenant: 'acme', scopes: ['admin'] }, { name: 'b-ci', tenant: 'b', scopes: ['read'] },
  ] });
  try {
    const get = async (/** @type {string} */ t, /** @type {string} */ who) => (await req(srv.url, `/v1/t/${t}/status`, { headers: bearer(secrets[who]) })).status;
    assert.equal(await get('acme', 'acme-admin'), 200);
    assert.equal(await get('b', 'acme-admin'), 404);
    assert.equal(await get('default', 'acme-admin'), 404);
    assert.equal(await get('b', 'root'), 200);
    assert.equal(await get('b', 'b-ci'), 200);
  } finally { await srv.close(); }
});

test('open mode refuses a request carrying any proxy or CDN header', async () => {
  const want = ['via', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server',
    'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'fastly-client-ip'];
  const { srv } = await boot();
  try {
    const problems = [];
    for (const h of want) {
      if (!PROXY_HEADERS.includes(h)) problems.push(`${h} is not in the list`);
      const s = (await req(srv.url, '/v1/t/default/maps', { headers: { [h]: '203.0.113.9' } })).status;
      if (s !== 403) problems.push(`${h}: ${s}`);
    }
    assert.deepEqual(problems, []);
    assert.equal((await req(srv.url, '/v1/t/default/maps')).status, 200);
  } finally { await srv.close(); }
});
