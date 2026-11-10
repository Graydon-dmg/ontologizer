// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
process.env.ONTOLOGIZER_STUB_SPEED = '50';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, seed } from './helpers-service.js';
import { openStore } from '../../src/core/store.js';
import { OPS, opByName } from '../../src/ops.js';
import { createClient, parseSse, OntologizerError, METHODS } from '../../src/client/index.js';

/** The whole client flow; returns the problems found. @param {ReturnType<typeof createClient>} c */
async function flowProblems(c) {
  const p = [];
  const chk = await c.maps.check('plastic model kits for hobbyists');
  if (!chk.ready) return ['check not ready'];
  const b = await c.maps.build(chk.brief, { name: chk.name });
  if (!b.id) return ['no id'];
  const w = await c.maps.wait(b.id, { timeout: 20000 });
  if (w.state !== 'idle') p.push(`wait ${w.state}`);
  if (!(await c.maps.list()).some((m) => m.id === b.id)) p.push('list lacks the id');
  const snap = await c.maps.snapshot(b.id);
  const nodes = Object.keys(snap.nodes ?? {}).length || (snap.nodes?.length ?? 0);
  if (!nodes) p.push('snapshot has no nodes');
  const outline = await c.maps.outline(b.id);
  const rootLabel = snap.nodes?.[snap.root]?.label ?? (snap.nodes ?? []).find?.((/** @type {any} */ n) => n.id === snap.root)?.label ?? snap.name;
  if (typeof outline !== 'string' || !outline.includes(rootLabel)) p.push(`outline lacks root label ${rootLabel}`);
  const hits = (await c.maps.search(b.id, String(rootLabel).split(/\s+/)[0])).results;
  if (!hits.length) p.push('search found nothing');
  const node = await c.maps.node(b.id, snap.root ?? hits[0].id);
  if (!node || typeof node !== 'object') p.push('node');
  const ctx = await c.maps.context(b.id);
  if (typeof ctx !== 'string' || !ctx) p.push('context');
  try { JSON.parse(await c.maps.export(b.id, { format: 'json' })); } catch { p.push('export json does not parse'); }
  const name = `kit-${Math.random().toString(36).slice(2, 8)}`;
  const s = await c.maps.save(b.id, name);
  if (!s.ok) p.push('save');
  if (!(await c.maps.list()).some((m) => m.id === name)) p.push('list lacks the saved name');
  return p;
}

test('client: check, build, wait, list, snapshot, outline, search, node, context, export, save (open mode)', async () => {
  const { srv, origin } = await boot();
  try {
    assert.deepEqual(await flowProblems(createClient({ url: origin })), []);
    // planted fault: a client whose list always answers empty is reported
    const c = createClient({ url: origin });
    const broken = { ...c, maps: { ...c.maps, list: async () => [] } };
    assert.ok((await flowProblems(/** @type {any} */ (broken))).some((x) => /list lacks/.test(x)));
  } finally { await srv.close(); }
});

test('client: the same flow with a token (tenant from the session)', async () => {
  const { srv, origin, secrets } = await boot({ tokens: [{ name: 'k', scopes: ['read', 'ask', 'build', 'admin'] }] });
  try {
    const c = createClient({ url: origin, token: secrets.k });
    assert.deepEqual(await flowProblems(c), []);
    assert.equal((await c.session()).tenant, 'default');
  } finally { await srv.close(); }
});

/** A fake SSE body: the given strings as chunks. @param {string[]} chunks */
const fakeBody = (chunks) => {
  const enc = new TextEncoder();
  let i = 0;
  return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }), cancel: async () => {} }) };
};
/** Problems with a parser: every event must come out, in order. @param {(b: any) => AsyncIterable<any>} parser */
async function parserProblems(parser) {
  const chunks = [': open\n\ndata: {"n":1}\n\ndata: {"n":2}\n\n', 'data: {"n":3', '}\r\n\r\nda', 'ta: {"n":4}\n\n:ping\n\ndata: {"n":5}\n\ndata: {"n":6}\n\n'];
  const got = [];
  for await (const e of parser(fakeBody(chunks))) got.push(e.n);
  const missing = [1, 2, 3, 4, 5, 6].filter((n) => !got.includes(n));
  return missing.length ? [`missing events ${missing.join(',')}`] : (got.join() === '1,2,3,4,5,6' ? [] : ['out of order']);
}

test('client: events iterator arrives in order, equals the store, and break closes the stream', async () => {
  const { srv, origin, home } = await boot();
  try {
    await seed(home, 'default', 'kits');
    const expected = [];
    for await (const e of openStore(home, { tenant: 'default' }).events('kits', { from: 0 })) { expected.push(e); if (expected.length === 20) break; }
    /** @type {AbortSignal[]} */ const signals = [];
    let cancelled = 0;
    /** @type {typeof fetch} */
    const spy = async (u, init) => {
      if (init?.signal) signals.push(init.signal);
      const res = await fetch(u, init);
      const reader = res.body?.getReader();
      const body = new ReadableStream({ async pull(ctl) { const r = await /** @type {any} */ (reader).read(); r.done ? ctl.close() : ctl.enqueue(r.value); }, cancel() { cancelled++; return reader?.cancel(); } });
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const c = createClient({ url: origin, fetch: spy });
    const got = [];
    for await (const ev of c.maps.events('kits', { from: 0 })) { got.push(ev); if (got.length === 20) break; }
    assert.deepEqual(got, expected);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, true, 'break aborted the request');
    assert.equal(cancelled, 1, 'break cancelled the body');
    // the caller's signal ends the iterator too
    const ac = new AbortController();
    const seen = [];
    for await (const ev of c.maps.events('kits', { from: 0, signal: ac.signal })) { seen.push(ev); if (seen.length === 3) ac.abort(); }
    assert.ok(seen.length >= 3);
  } finally { await srv.close(); }
});

test('client: parseSse handles several events per chunk and events split across chunks', async () => {
  assert.deepEqual(await parserProblems(parseSse), []);
  // planted fault: a parser that stops after the first chunk is reported
  /** @param {any} body */
  async function* firstChunkOnly(body) {
    const r = body.getReader(); const { value } = await r.read();
    for (const block of new TextDecoder().decode(value).split('\n\n')) if (block.startsWith('data: ')) yield JSON.parse(block.slice(6));
  }
  assert.ok((await parserProblems(firstChunkOnly)).some((x) => /missing events/.test(x)));
});

/** Problems with how a call fails. @param {() => Promise<any>} run @param {number} status */
async function errorProblems(run, status) {
  try { await run(); } catch (e) {
    if (!(e instanceof OntologizerError)) return ['threw something else'];
    return e.status === status ? [] : [`status ${e.status}`];
  }
  return ['did not throw'];
}

test('client: errors throw OntologizerError (403, 404, 429 with retryAfter)', async () => {
  const { srv, origin, secrets, home } = await boot({ tokens: [{ name: 'ro', scopes: ['read'] }] });
  try {
    await seed(home, 'default', 'kits');
    const c = createClient({ url: origin, token: secrets.ro });
    assert.deepEqual(await errorProblems(() => c.maps.build({ context: 'x' }), 403), []);
    assert.deepEqual(await errorProblems(() => c.maps.snapshot('nope'), 404), []);
    /** @type {typeof fetch} */
    const limited = async (u) => String(u).includes('/v1/session')
      ? Response.json({ tenant: 'default' })
      : new Response(JSON.stringify({ error: 'slow down' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
    const lc = createClient({ url: origin, fetch: limited });
    const e = await lc.maps.list().catch((x) => x);
    assert.ok(e instanceof OntologizerError);
    assert.equal(e.status, 429); assert.equal(e.retryAfter, 30); assert.equal(e.error, 'slow down');
    // planted fault: a client that returns the error body instead of throwing is reported
    /** @type {typeof fetch} */
    const lenient = async (u, i) => { const r = await fetch(u, i); return r.ok ? r : new Response(await r.text(), { status: 200, headers: r.headers }); };
    const bad = createClient({ url: origin, token: secrets.ro, fetch: lenient });
    assert.deepEqual(await errorProblems(() => bad.maps.snapshot('nope'), 404), ['did not throw']);
  } finally { await srv.close(); }
});

/** Problems: each method names an existing op; each mcp op has a method. @param {Record<string, string>} table */
const tableProblems = (table) => [
  ...Object.entries(table).filter(([, op]) => !opByName(op)).map(([m, op]) => `${m} names unknown op ${op}`),
  ...OPS.filter((o) => o.mcp && !Object.values(table).includes(o.name) && !['research', 'explain', 'sources', 'fuse', 'rosetta'].includes(o.name)).map((o) => `no method for ${o.name}`),
];

test('client: every method maps to an op, every mcp op has a method', () => {
  assert.deepEqual(tableProblems(METHODS), []);
  // the jobs are reached through maps.actions: each has an op
  for (const t of ['research', 'explain', 'sources', 'fuse', 'rosetta']) assert.ok(opByName(t), t);
  // planted fault
  assert.deepEqual(tableProblems({ ...METHODS, 'maps.bogus': 'no_such_op' }), ['maps.bogus names unknown op no_such_op']);
  assert.ok(tableProblems({}).length > 0);
});

/** Problems: a source must not use node: or Node globals. @param {string} src */
const browserProblems = (src) => [
  ...(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]node:/.test(src) ? ['imports node:'] : []),
  ...(/\brequire\s*\(/.test(src) ? ['uses require'] : []),
  ...(/\bprocess\./.test(src) ? ['uses process'] : []),
  ...(/\bBuffer\b/.test(src) ? ['uses Buffer'] : []),
];

test('client: browser safety of the client and ops.js', () => {
  for (const f of ['../../src/client/index.js', '../../src/ops.js']) {
    assert.deepEqual(browserProblems(fs.readFileSync(new URL(f, import.meta.url), 'utf8')), [], f);
  }
  assert.deepEqual(browserProblems("import fs from 'node:fs';"), ['imports node:']);
});
