// @ts-check
// I2 and I4 together: a map that became private through its events (not a hand-set flag) exports with
// the Private mark in every format; a principal who can read it gets the snapshot the Export menu
// exports, and one who cannot gets the same 404 as for a map that does not exist; the embed's details
// panel lists source refs safely. Each check has a planted fault.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAll } from '../../src/core/events.js';
import { exportMap, FORMATS } from '../../src/core/export/index.js';
import { nodeDetails } from '../../web/embed/helpers.js';
import { startService } from '../../src/server/service.js';
import { openStore } from '../../src/core/store.js';
import { createToken, tokensPath } from '../../src/server/tokens.js';
import { bundleText, privateMarkProblems } from './build-check.js';
import { fixtureEvents, req, stubEngine, tempHome } from './helpers-service.js';

const RAISE = { t: 'visibility.raised', at: 1, to: 'private', reason: 'source', sources: ['wiki'] };
/** The plastic-modeling map made private by a raise, with a node citing source refs. */
function privateEvents() {
  const ev = fixtureEvents('plastic-modeling');
  const node = ev.find((e) => e.t === 'node.added' && e.node.depth === 1);
  const refs = [
    { source: 'wiki', ref: 'doc-glue', title: 'Choosing glue', url: 'https://wiki.example/doc-glue' },
    { source: 'wiki', ref: 'doc-2', title: 'Bad link', url: 'javascript:alert(1)' },
    { source: 'wiki', ref: 'doc-3', title: 'No link' },
    { source: 'wiki', ref: 'doc-4' },
  ];
  return [ev[0], RAISE, ...ev.slice(1), { t: 'node.updated', at: 2, id: node.node.id, patch: { sources: refs } }];
}

test('a map made private by its events exports with the Private mark in every format; the public map does not', async () => {
  const bundle = await bundleText();
  const priv = foldAll(privateEvents());
  assert.equal(priv.visibility, 'private');
  for (const format of FORMATS) {
    const out = exportMap(priv, { format, bundle });
    assert.deepEqual(privateMarkProblems(format, out), [], format);
    if (format === 'context') assert.match(out.split('\n')[0], /Private/);
  }
  // Planted fault: the same map exported as if the raise never happened (visibility lost on the way).
  const lost = { ...priv, visibility: 'public', privateSources: [] };
  for (const format of FORMATS) assert.ok(privateMarkProblems(format, exportMap(lost, { format, bundle })).length > 0, format);
});

/** The statuses and bodies a caller gets for a map's export-feeding routes. @param {string} url @param {string} id @param {Record<string, string>} h */
async function exportRoutes(url, id, h) {
  const out = {};
  for (const [k, p, accept] of [['snapshot', 'snapshot', 'application/json'], ['api', 'api/snapshot', 'application/json'],
    ['events', 'events', 'text/event-stream'], ['view', 'view', 'text/html']]) {
    const r = await req(url, `/v1/t/default/maps/${id}/${p}`, { headers: { ...h, accept } });
    /** @type {any} */ (out)[k] = { status: r.status, body: k === 'events' && r.status === 200 ? '(stream)' : r.body };
  }
  return out;
}

test('service mode: a reader of the private map exports it (Private mark); one who cannot gets the same 404 as a missing map', async () => {
  const home = tempHome();
  openStore(home).importEvents('secret-map', privateEvents());
  const team = createToken(tokensPath(home), { name: 'team', scopes: ['read', 'build'], sources: ['wiki'] }).token;
  const reader = createToken(tokensPath(home), { name: 'reader', scopes: ['read', 'build'] }).token;
  const config = { sources: [{ name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'private', allowTools: ['search'] }] };
  const srv = await startService({
    home, host: '127.0.0.1', port: 0, tokensFile: tokensPath(home), config, version: 'test',
    makeEngine: async (/** @type {any} */ x) => stubEngine(x),
    sources: /** @type {any} */ ({ entries: config.sources, names: () => ['wiki'], get: () => config.sources[0], status: async () => [], toolset: async () => null, close: async () => {} }),
  });
  try {
    // Team: the snapshot the Export menu exports carries the mark through every format.
    const snap = await req(srv.url, '/v1/t/default/maps/secret-map/snapshot', { headers: { authorization: `Bearer ${team}` } });
    assert.equal(snap.status, 200);
    const bundle = await bundleText();
    for (const format of FORMATS) assert.deepEqual(privateMarkProblems(format, exportMap(snap.json(), { format, bundle })), [], format);
    // The bundle the menu fetches is a static file, the same for everyone (it holds no map).
    assert.equal((await req(srv.url, '/dist/embed.js')).status, 200);

    // Reader: every route that feeds an export answers exactly as for a map that does not exist.
    const h = { authorization: `Bearer ${reader}` };
    const hidden = await exportRoutes(srv.url, 'secret-map', h);
    const missing = await exportRoutes(srv.url, 'no-such-map', h);
    assert.deepEqual(hidden, missing);
    for (const k of Object.keys(hidden)) assert.equal(/** @type {any} */ (hidden)[k].status, 404, k);
    assert.ok(!JSON.stringify(hidden).includes('secret-map'));
    // Planted fault: a hidden map that answers differently from a missing one (an oracle) is caught.
    assert.notDeepEqual({ ...hidden, snapshot: { status: 403, body: '{"ok":false,"error":"forbidden"}' } }, missing);
  } finally { await srv.close(); }
});

/** Problems in the embed's details panel sources. @param {{ title: string, href: string|null }[]} list */
function refProblems(list) {
  const p = [];
  for (const s of list) if (s.href && !/^https?:\/\//.test(s.href)) p.push(`unsafe link: ${s.href}`);
  const titles = list.map((s) => s.title);
  for (const want of ['wiki · Choosing glue', 'wiki · Bad link', 'wiki · No link', 'wiki · doc-4']) if (!titles.includes(want)) p.push(`missing ${want}`);
  if (list.find((s) => s.title === 'wiki · Choosing glue')?.href !== 'https://wiki.example/doc-glue') p.push('the http ref is not a link');
  return p;
}

test('the embed\'s details panel lists every source ref as "source · title", linking http/https only', () => {
  const o = foldAll(privateEvents());
  const id = Object.values(o.nodes).find((n) => (n.sources ?? []).some((/** @type {any} */ s) => s.source))?.id;
  assert.ok(id);
  const d = /** @type {any} */ (nodeDetails(o, /** @type {string} */ (id)));
  assert.deepEqual(refProblems(d.sources), []);
  // Planted faults: a javascript: link, and refs without a url collapsed into one (dedupe by url).
  assert.ok(refProblems([{ title: 'wiki · Choosing glue', href: 'javascript:alert(1)' }]).length > 0);
  assert.ok(refProblems([{ title: 'wiki · Choosing glue', href: 'https://wiki.example/doc-glue' }, { title: 'No link', href: null }]).length >= 2);
});
