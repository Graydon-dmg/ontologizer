// @ts-check
// The map page under /v1/t/default/maps/<id>/view loads its events from <base>/api/events, and no
// shell call is left on a bare /api/.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, req, seed, readSse } from './helpers-service.js';
import { startServer } from '../../src/server/index.js';
import { openStore } from '../../src/core/store.js';
import { createEngine } from '../../src/cli/engine-stub.js';
import { tempHome } from './helpers-service.js';

const SHELL = new URL('../../web/shell/', import.meta.url).pathname;

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Every string that starts with "/api/" in code (not comments) must be an argument of api() or route().
 * @param {string} src @param {string} name @returns {string[]}
 */
export function bareApiCalls(src, name) {
  const problems = [];
  const lines = src.split('\n');
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    const code = line.replace(/\s\/\/ .*$/, '');
    for (const m of code.matchAll(/['"`]\/api\//g)) {
      const before = code.slice(0, m.index);
      if (!/(?:\bapi|\broute)\($/.test(before)) problems.push(`${name}:${i + 1}: ${t}`);
    }
  }
  return problems;
}

test('every /api/ call in web/shell goes through api() (the page\'s base path)', () => {
  const problems = jsFiles(SHELL).flatMap((f) => bareApiCalls(fs.readFileSync(f, 'utf8'), path.relative(SHELL, f)));
  assert.deepEqual(problems, []);
  // Planted fault: a shell call left on a bare /api/ is reported.
  assert.equal(bareApiCalls("      const res = await fetch('/api/maps');", 'ui/fuse.js').length, 1);
  assert.equal(bareApiCalls('    es = new ES(`/api/events?from=${received}`);', 'source.js').length, 1);
  assert.equal(bareApiCalls("const r = await fetch(api('/api/maps'));", 'ok.js').length, 0);
});

test('the map page under /v1/t/default/maps/<id>/view loads its events from <base>/api/events', async () => {
  const { srv, home } = await boot();
  try {
    await seed(home, 'default', 'demo');
    const page = await req(srv.url, '/v1/t/default/maps/demo/view');
    assert.equal(page.status, 200);
    const m = /<meta name="ontologizer-base" content="([^"]*)">/.exec(page.body);
    assert.ok(m, 'the page carries the base meta');
    const base = m[1];
    assert.equal(base, '/v1/t/default/maps/demo');
    assert.match(page.body, /<script type="importmap">/);
    assert.match(page.body, /id="server-panel"/);

    // The page's own modules, as the browser runs them: base.js reads the meta.
    /** @type {any} */ (globalThis).document = { querySelector: (/** @type {string} */ s) => (s === 'meta[name="ontologizer-base"]' ? { content: base } : null) };
    const { BASE, api, TENANT } = await import('../../web/shell/base.js');
    const { createSource } = await import('../../web/shell/source.js');
    delete (/** @type {any} */ (globalThis).document);
    assert.equal(BASE, base);
    assert.equal(TENANT, 'default');
    /** @type {string[]} */
    const opened = [];
    class FakeES { constructor(/** @type {string} */ u) { opened.push(u); } close() {} }
    /** @type {string[]} */
    const posted = [];
    const src = createSource({ search: '', EventSource: FakeES, fetch: /** @type {any} */ (async (/** @type {string} */ u) => { posted.push(u); return { ok: true, json: async () => ({ ok: true }) }; }) });
    await src.act({ type: 'focus', nodeId: 'x' });
    src.close?.();
    assert.deepEqual(opened, [`${base}/api/events?from=0`]);
    assert.deepEqual(posted, [`${base}/api/action`]);
    assert.equal(api('/api/maps'), `${base}/api/maps`);

    // And that URL is live on the router: the map's events stream from it.
    const ev = await readSse(srv.url, opened[0], 3);
    assert.equal(ev.status, 200);
    assert.equal(ev.events[0].t, 'ontology.created');
    const maps = await req(srv.url, `${base}/api/maps`);
    assert.equal(maps.status, 200);
    // A bare /api/ is not a route in service mode (the planted fault would load nothing).
    assert.equal((await req(srv.url, '/api/events?from=0')).status, 404);
  } finally { await srv.close(); }
});

test('the one-map server still serves the page with an empty base, and its /api/ routes at the root', async () => {
  const store = openStore(tempHome());
  store.importEvents('demo', fs.readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const srv = await startServer({ store, engine: createEngine({ store, id: 'demo' }), id: 'demo' });
  try {
    const page = await req(srv.url, '/');
    assert.match(page.body, /<meta name="ontologizer-base" content="">/);
    const ev = await readSse(srv.url, '/api/events?from=0', 2);
    assert.equal(ev.events.length, 2);
  } finally { await srv.close(); }
});
