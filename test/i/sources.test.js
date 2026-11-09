// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { offeredTools, refsFrom, resultText, heldSources, createSources } from '../../src/server/sources.js';
import { buildStubServer, calls } from './fixtures/stub-mcp.js';

/** @param {any} [over] */
const entry = (over = {}) => ({ name: 'wiki', url: 'https://wiki.example/mcp', visibility: 'public', allowTools: ['search', 'get', 'delete_page'], ...over });

/** An injectable connect that serves the stub through InMemoryTransport. @param {string[]} [log] */
function memConnect(log = []) {
  const servers = [];
  const connect = async (/** @type {any} */ e, /** @type {any} */ headers) => {
    log.push(JSON.stringify(headers));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildStubServer({ name: e.name });
    servers.push(server);
    await server.connect(b);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(a);
    return client;
  };
  return connect;
}

const TOOLS = [
  { name: 'search', annotations: { readOnlyHint: true } },
  { name: 'get', annotations: { readOnlyHint: true } },
  { name: 'delete_page', annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'secret_search', annotations: { readOnlyHint: true } },
  { name: 'bare' },
];

test('offeredTools: allowTools, readOnlyHint, usable name (planted faults)', () => {
  const v = Object.fromEntries(offeredTools(entry({ allowTools: ['search', 'get', 'delete_page', 'bare'] }), TOOLS).map((t) => [t.name, t]));
  assert.equal(v.search.offered, true);
  assert.equal(v.get.offered, true);
  assert.deepEqual([v.delete_page.offered, v.delete_page.why], [false, 'not marked readOnlyHint']); // planted: write tool in allowTools
  assert.deepEqual([v.secret_search.offered, v.secret_search.why], [false, 'not in allowTools']); // planted: read-only, not allowed
  assert.equal(v.bare.why, 'not marked readOnlyHint');
  const bad = offeredTools(entry({ allowTools: ['has space', 'x'.repeat(70)] }), [{ name: 'has space', annotations: { readOnlyHint: true } }, { name: 'x'.repeat(70), annotations: { readOnlyHint: true } }]);
  assert.deepEqual(bad.map((t) => t.why), ['name not usable', 'name not usable']);
});

test('toolset offers only search and get; a write tool never reaches the server', async () => {
  calls.length = 0;
  const s = createSources([entry()], { connect: memConnect() });
  try {
    const ts = await s.toolset({ scopes: ['read'] }, ['wiki']);
    assert.ok(ts);
    assert.deepEqual(ts.names, ['wiki__search', 'wiki__get']);
    assert.match(ts.defs[0].description, /^\[wiki, public source\] /);
    assert.ok(ts.defs[0].input_schema);
    for (const bad of ['wiki__delete_page', 'wiki__secret_search', 'delete_page', 'nope']) {
      const r = await ts.call(bad, { ref: 'doc-glue' });
      assert.equal(r.isError, true, bad);
      assert.equal(r.text, 'That tool is not offered.');
      assert.deepEqual(r.refs, []);
    }
    assert.deepEqual(calls, []); // planted: had delete_page run, it would be recorded here
    const ok = await ts.call('wiki__search', { query: 'glue' });
    assert.equal(ok.isError, false);
    assert.equal(ok.source, 'wiki');
    assert.ok(ok.refs.some((r) => r.ref === 'doc-glue' && r.url === 'https://wiki.example/doc-glue' && r.title === 'Choosing glue'));
    const got = await ts.call('wiki__get', { ref: 'doc-paint' });
    assert.deepEqual(got.refs.map((r) => r.url), ['https://wiki.example/doc-paint']);
    // and the recorder itself works: a direct call to the stub is recorded
    const c = await memConnect()(entry(), {});
    await c.callTool({ name: 'delete_page', arguments: { ref: 'x' } });
    await c.close();
    assert.deepEqual(calls, ['x']);
  } finally { await s.close(); calls.length = 0; }
});

test('toolset: null for no names or nothing offered; unreachable sources are skipped and logged', async () => {
  const lines = [];
  const connect = async (/** @type {any} */ e, /** @type {any} */ h) => { if (e.name === 'down') throw new Error('refused'); return memConnect()(e, h); };
  const s = createSources([entry(), entry({ name: 'down' }), entry({ name: 'none', allowTools: ['secret_search_x'] })], { connect, log: (l) => lines.push(l) });
  try {
    assert.equal(await s.toolset({}, []), null);
    assert.equal(await s.toolset({}, ['none']), null);
    const ts = await s.toolset({}, ['wiki', 'down']);
    assert.deepEqual(ts?.names, ['wiki__search', 'wiki__get']);
    assert.ok(lines.some((l) => /down/.test(l) && /refused/.test(l)));
    const st = await s.status();
    assert.deepEqual(st.map((r) => [r.name, r.reachable]), [['wiki', true], ['down', false], ['none', true]]);
    assert.equal(st[1].error, 'refused');
    assert.equal(st[0].tools?.find((t) => t.name === 'delete_page')?.why, 'not marked readOnlyHint');
    assert.deepEqual(s.names(), ['wiki', 'down', 'none']);
    assert.equal(s.get('wiki')?.name, 'wiki');
    assert.equal(s.get('x'), undefined);
  } finally { await s.close(); }
});

test('headers(principal) reach connect; connections are cached per headers; a throwing headers fn is unreachable', async () => {
  const seen = [];
  const e = entry({ headers: (/** @type {any} */ p) => { if (p?.bad) throw new Error('no token'); return { authorization: `Bearer ${p.id}` }; } });
  const s = createSources([e], { connect: memConnect(seen) });
  try {
    await s.toolset({ id: 'a' }, ['wiki']);
    await s.toolset({ id: 'a' }, ['wiki']);
    assert.deepEqual(seen, ['{"authorization":"Bearer a"}']);
    await s.toolset({ id: 'b' }, ['wiki']);
    assert.equal(seen.length, 2);
    assert.equal(seen[1], '{"authorization":"Bearer b"}');
    assert.equal(await s.toolset({ bad: true }, ['wiki']), null);
    const st = await s.status({ principal: { bad: true } });
    assert.deepEqual([st[0].reachable, st[0].error], [false, 'no token']);
  } finally { await s.close(); }
});

test('connect timeout makes a source unreachable', async () => {
  const s = createSources([entry()], { connect: () => new Promise(() => {}), timeoutMs: 50 });
  const st = await s.status();
  assert.equal(st[0].reachable, false);
  assert.match(st[0].error ?? '', /timed out/);
});

test('refsFrom: every block kind; http(s) urls only; errors give none (planted faults)', () => {
  const r = refsFrom('wiki', { content: [
    { type: 'resource_link', uri: 'https://wiki.example/a', name: 'a-name', title: ' A title ' },
    { type: 'resource_link', uri: 'doc://b', name: 'B' },
    { type: 'resource', resource: { uri: 'https://wiki.example/c', title: 'C', text: 'x' } },
    { type: 'text', text: JSON.stringify({ deep: [{ ref: 'd', title: 'D', url: 'https://wiki.example/d' }] }) },
    { type: 'text', text: 'not json' },
  ], structuredContent: { results: [{ ref: 'e', url: 'javascript:alert(1)' }, { ref: 'a' }, { ref: ' f ', title: 'F' }] } });
  const by = Object.fromEntries(r.map((x) => [x.ref, x]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'd', 'doc://b', 'e', 'f', 'https://wiki.example/a', 'https://wiki.example/c']);
  assert.equal(by['https://wiki.example/a'].title, 'A title');
  assert.equal(by['https://wiki.example/a'].url, 'https://wiki.example/a');
  assert.equal(by['doc://b'].url, undefined);
  assert.equal(by['doc://b'].title, 'B');
  assert.equal(by.e.url, undefined); // planted: javascript: url dropped, ref kept
  assert.equal(by.d.url, 'https://wiki.example/d');
  assert.equal(by.f.title, 'F');
  assert.ok(r.every((x) => x.source === 'wiki'));
  assert.deepEqual(refsFrom('wiki', { isError: true, content: [{ type: 'resource_link', uri: 'https://x.example/' }], structuredContent: { ref: 'z' } }), []);
  // dedupe, depth limit, caps
  assert.equal(refsFrom('w', { structuredContent: { results: [{ ref: 'a' }, { ref: 'a' }] } }).length, 1);
  assert.equal(refsFrom('w', { structuredContent: { a: { b: { c: { d: { e: { ref: 'deep' } } } } } } }).length, 0);
  assert.equal(refsFrom('w', { structuredContent: { a: { b: { c: { d: { ref: 'ok' } } } } } }).length, 1);
  assert.equal(refsFrom('w', { structuredContent: [{ ref: 'x'.repeat(501) }] }).length, 0);
  assert.equal(refsFrom('w', { structuredContent: [{ ref: 'x', title: 't'.repeat(201) }] })[0].title, undefined);
});

test('resultText: text blocks, else structuredContent, capped', () => {
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(resultText({ content: [], structuredContent: { k: 1 } }), '{"k":1}');
  assert.equal(resultText({ content: [{ type: 'text', text: 'x'.repeat(30000) }] }).length, 20000);
});

test('heldSources rules', () => {
  const es = [entry({ name: 'pub' }), entry({ name: 'priv', visibility: 'private' }), entry({ name: 'pub2' })];
  assert.deepEqual(heldSources(es, { scopes: ['admin'] }), ['pub', 'priv', 'pub2']);
  assert.deepEqual(heldSources(es, { scopes: ['read'] }), ['pub', 'pub2']); // no list: public only
  assert.deepEqual(heldSources(es, { scopes: ['read'], sources: ['priv', 'ghost'] }), ['priv']);
  assert.deepEqual(heldSources(es, { scopes: ['read'], sources: [] }), []);
  assert.deepEqual(heldSources(es, { scopes: ['admin'], sources: [] }), ['pub', 'priv', 'pub2']);
});

test('over stdio: the real transport lists, calls and closes', async () => {
  const path = new URL('./fixtures/stub-mcp.js', import.meta.url).pathname;
  const s = createSources([entry({ url: undefined, command: process.execPath, args: [path, '--name', 'docs'] })]);
  try {
    const ts = await s.toolset({}, ['wiki']);
    assert.deepEqual(ts?.names, ['wiki__search', 'wiki__get']);
    const r = await ts?.call('wiki__search', { query: 'sanding' });
    assert.ok(r?.refs.some((x) => x.url === 'https://docs.example/doc-sanding'));
  } finally { await s.close(); }
});
