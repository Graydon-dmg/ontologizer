// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// C · add_node through the live router (stub engine): POST …/actions { type: 'add_node' } answers 201
// with the node; concurrent calls never share an id; /events subscribers see it; it calls no model and
// starts no job; a read token is refused; a building map answers 409 BUSY. Each check has its planted fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../src/core/store.js';
import { BUSY } from '../../src/server/texts.js';
import { boot, req, readSse, seed } from '../i/helpers-service.js';
import { faultyModule } from '../i/helpers-fault.js';

const P = 'plastic-modeling';
const AT = `/v1/t/default/maps/${P}`;

/** @param {string} origin @param {any} body @param {string} [token] */
async function add(origin, body, token) {
  const r = await req(origin, `${AT}/actions`, { method: 'POST', body: { type: 'add_node', ...body },
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, body: /** @type {any} */ (JSON.parse(r.body || '{}')) };
}
/** The map's events as stored now (a fresh store). @param {string} home @param {string} [id] */
async function stored(home, id = P) {
  /** @type {any[]} */ const out = [];
  for await (const e of openStore(home, { tenant: 'default' }).events(id)) out.push(e);
  return out;
}

/** The problems with n parallel adds of distinct labels: all 201, all ids distinct. @param {Array<{ status: number, body: any }>} rs */
function distinctProblems(rs) {
  /** @type {string[]} */ const p = [];
  const bad = rs.filter((r) => r.status !== 201);
  if (bad.length) p.push(`${bad.length} not 201: ${JSON.stringify(bad[0])}`);
  const ids = new Set(rs.map((r) => r.body.node?.id));
  if (ids.size !== rs.length) p.push(`${ids.size} distinct ids for ${rs.length} calls`);
  return p;
}

test('201 { ok, node } with the folded node; exactly one node.added; no job, no model call', async () => {
  const { srv, origin, home } = await boot();
  try {
    await seed(home, 'default', P);
    const before = await stored(home);
    const usage0 = JSON.parse((await req(origin, '/v1/t/default/usage', { headers: { accept: 'application/json' } })).body);
    const r = await add(origin, { parentId: `${P}/tools`, label: 'Airbrushes', summary: 'Spray paint finely' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const snap = JSON.parse((await req(origin, `${AT}/snapshot`, { headers: { accept: 'application/json' } })).body);
    assert.deepEqual(r.body.node, snap.nodes[`${P}/tools/airbrushes`]);
    const added = (await stored(home)).slice(before.length);
    assert.deepEqual(added.map((e) => e.t), ['node.added']);
    assert.ok(!added.some((e) => e.t.startsWith('job.')));
    const usage1 = JSON.parse((await req(origin, '/v1/t/default/usage', { headers: { accept: 'application/json' } })).body);
    assert.deepEqual(usage1, usage0);
  } finally { await srv.close(); }
});

test('concurrency: 20 parallel distinct labels get 20 ids; 2 parallel same labels give one 201 and one 409', async () => {
  const { srv, origin, home } = await boot();
  try {
    await seed(home, 'default', P);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => add(origin, { parentId: `${P}/tools`, label: `Tool ${i}` })));
    assert.deepEqual(distinctProblems(rs), []);
    const two = await Promise.all([add(origin, { parentId: `${P}/tools`, label: 'Same' }), add(origin, { parentId: `${P}/tools`, label: 'same' })]);
    assert.deepEqual(two.map((r) => r.status).sort(), [201, 409]);
    const nodes = (await stored(home)).filter((e) => e.t === 'node.added' && /\/same(-\d+)?$/.test(e.node.id));
    assert.equal(nodes.length, 1);
  } finally { await srv.close(); }
});

test('planted fault: an await between the read and the append hands two calls the same parent snapshot', async () => {
  // The broken copy yields between reading the map and appending: two same-label calls both pass the
  // duplicate check, so the check above (one 201, one 409) would fail.
  const f = await faultyModule('src/server/actions/add-node.js', [
    ['export function addNode(', 'export async function addNode('],
    ['  const nid = childId(', '  await new Promise((r) => setTimeout(r, 20));\n  const nid = childId('],
    ['  const r = addNode(', '  const r = await addNode('],
  ]);
  const home = (await import('../i/helpers-service.js')).tempHome();
  await seed(home, 'default', P);
  const store = openStore(home, { tenant: 'default' });
  const emit = (/** @type {string} */ t, /** @type {object} */ fields) => store.append(P, { t, at: store.now(P), ...fields });
  const rs = await Promise.all([f.addNode(store, P, { parentId: `${P}/tools`, label: 'Same' }, { emit }), f.addNode(store, P, { parentId: `${P}/tools`, label: 'Same' }, { emit })]);
  assert.notDeepEqual(rs.map((r) => r.status).sort(), [201, 409]);
});

test('the live stream sees it: an /events subscriber receives node.added for the new id', async () => {
  const { srv, origin, home } = await boot();
  try {
    await seed(home, 'default', P);
    const n = (await stored(home)).length;
    const sse = readSse(origin, `${AT}/events`, n + 1);
    await new Promise((r) => setTimeout(r, 200));
    const r = await add(origin, { parentId: `${P}/tools`, label: 'Airbrushes' });
    assert.equal(r.status, 201);
    const { events } = await sse;
    assert.ok(events.some((e) => e.t === 'node.added' && e.node?.id === `${P}/tools/airbrushes`), `got ${events.length} events`);
  } finally { await srv.close(); }
});

test('a read token is refused with 403 and nothing is written', async () => {
  const { srv, origin, home, secrets } = await boot({ tokens: [{ name: 'ro', scopes: ['read'] }, { name: 'rw', scopes: ['read', 'build'] }] });
  try {
    await seed(home, 'default', P);
    const n = (await stored(home)).length;
    assert.equal((await add(origin, { parentId: `${P}/tools`, label: 'X' }, secrets.ro)).status, 403);
    assert.equal((await stored(home)).length, n);
    assert.equal((await add(origin, { parentId: `${P}/tools`, label: 'X' }, secrets.rw)).status, 201);
  } finally { await srv.close(); }
});

test('while the map builds: 409 BUSY and nothing written', async () => {
  const { srv, origin, home } = await boot();
  try {
    const b = await req(origin, '/v1/t/default/maps', { method: 'POST', body: { brief: { context: 'plastic modelling' } }, headers: { accept: 'application/json' } });
    assert.equal(b.status, 202, b.body);
    const id = JSON.parse(b.body).id;
    await new Promise((r) => setTimeout(r, 300));   // the stub replays the fixture at its own pace
    const n = (await stored(home, id)).length;
    const root = openStore(home, { tenant: 'default' }).read(id).root || 'plastic-modeling';
    const r = await req(origin, `/v1/t/default/maps/${id}/actions`, { method: 'POST', body: { type: 'add_node', parentId: root, label: 'Mid build' }, headers: { accept: 'application/json' } });
    assert.deepEqual({ status: r.status, body: JSON.parse(r.body) }, { status: 409, body: { ok: false, error: BUSY } });
    assert.ok(!(await stored(home, id)).slice(n).some((e) => e.t === 'node.added' && e.node.label === 'Mid build'));
  } finally { await srv.close(); }
});
