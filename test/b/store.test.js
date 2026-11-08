// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../../src/core/store.js';
import { foldAll } from '../../src/core/events.js';
import { tempHome, fixtureEvents } from './helpers.js';

const BRIEF = { context: 'c', subject: 's', scope: 'x', purpose: 'p', level: 'beginner' };

/** @param {ReturnType<typeof openStore>} store @param {string} name */
function savedWith(store, name) {
  const id = store.createDraft(BRIEF, name);
  store.append(id, { t: 'ontology.created', at: 0, name, root: 'r', brief: BRIEF, categories: [] });
  return store.save(id, name);
}

test('resolve: ambiguous prefix lists every match; a first-match resolver would fail', () => {
  const store = openStore(tempHome());
  savedWith(store, 'modeling');
  savedWith(store, 'manga');
  const expected = { ambiguous: ['manga', 'modeling'] };
  assert.deepEqual(store.resolve('m'), expected);
  assert.equal(store.resolve('manga'), 'manga');
  assert.equal(store.resolve('mo'), 'modeling');
  assert.equal(store.resolve('zzz'), null);
  const rows = store.list();
  /** @param {string} p */
  const firstMatchResolve = (p) => rows.find((r) => r.id.startsWith(p))?.id ?? null;
  assert.notDeepEqual(firstMatchResolve('m'), expected);
});

test('fold round trip: a new store reads the same ontology; dropping view.changed would differ', async () => {
  const home = tempHome();
  const a = openStore(home);
  const events = fixtureEvents('plastic-modeling');
  const id = a.createDraft(events[0].brief, 'Plastic modeling');
  for (const e of events) a.append(id, e);
  const cat = events.find((e) => e.t === 'category.added').category.id;
  const nodeId = events.filter((e) => e.t === 'node.added')[3].node.id;
  const last = events[events.length - 1].at;
  a.append(id, { t: 'view.changed', at: last + 1, patch: { collapsed: [cat] } });
  a.append(id, { t: 'view.changed', at: last + 2, patch: { focus: nodeId } });
  a.save(id, 'plastic-modeling');

  const b = openStore(home);
  const read = b.read('plastic-modeling');
  const stored = [];
  for await (const e of b.events('plastic-modeling')) stored.push(e);
  assert.equal(stored[stored.length - 1].t, 'ontology.renamed');
  assert.equal(stored.length, events.length + 3);
  assert.deepEqual(read, foldAll(stored));
  assert.deepEqual(read.view.collapsed, [cat]);
  assert.equal(read.view.focus, nodeId);
  const dropped = foldAll(stored.filter((e) => e.t !== 'view.changed'));
  assert.notDeepEqual(dropped.view, read.view);
  // snapshot on disk matches too
  const snap = JSON.parse(fs.readFileSync(path.join(home, 'plastic-modeling', 'snapshot.json'), 'utf8'));
  assert.deepEqual(snap, read);
  assert.deepEqual(b.list().map((r) => r.id), ['plastic-modeling']);
  assert.equal(b.list()[0].nodes, Object.keys(read.nodes).length);
});

test('save refuses an existing name unless overwrite; refuses non-kebab names', () => {
  const store = openStore(tempHome());
  savedWith(store, 'taken');
  const id = store.createDraft(BRIEF, 'x');
  store.append(id, { t: 'ontology.created', at: 0, name: 'x', root: 'r', brief: BRIEF, categories: [] });
  assert.throws(() => store.save(id, 'taken'), /already exists/);
  assert.throws(() => store.save(id, 'Bad Name'), /Invalid name/);
  assert.throws(() => store.save(id, '../evil'), /Invalid name/);
  assert.equal(store.save(id, 'taken', { overwrite: true }), 'taken');
  assert.equal(store.list().filter((r) => r.id === 'taken').length, 1);
  assert.equal(store.current(), 'taken');
  assert.equal(store.read('taken').name, 'taken');
});

test('subscribe fires fn(event, index) per append; unsubscribe stops it', () => {
  const store = openStore(tempHome());
  const id = store.createDraft(BRIEF, 'n');
  /** @type {any[]} */
  const seen = [];
  const un = store.subscribe(id, (e, i) => seen.push([e.t, i]));
  store.append(id, { t: 'ontology.created', at: 0, name: 'n', root: 'r', brief: BRIEF, categories: [] });
  store.append(id, { t: 'insight', at: 1, text: 'hi' });
  assert.deepEqual(seen, [['ontology.created', 0], ['insight', 1]]);
  un();
  store.append(id, { t: 'insight', at: 2, text: 'again' });
  assert.equal(seen.length, 2);
});

test('events(id,{from:5}) yields stored events from index 5 in order', async () => {
  const store = openStore(tempHome());
  const id = store.createDraft(BRIEF, 'n');
  store.append(id, { t: 'ontology.created', at: 0, name: 'n', root: 'r', brief: BRIEF, categories: [] });
  for (let i = 1; i < 9; i++) store.append(id, { t: 'insight', at: i, text: `t${i}` });
  const got = [];
  for await (const e of store.events(id, { from: 5 })) got.push(e.at);
  assert.deepEqual(got, [5, 6, 7, 8]);
  const all = [];
  for await (const e of store.events(id)) all.push(e.at);
  assert.equal(all.length, 9);
});

test('sessions.get ignores and removes an entry with a dead pid; keeps a live one', () => {
  const home = tempHome();
  const store = openStore(home);
  store.sessions.set('dead', { port: 1, pid: 999999, startedAt: 1 });
  store.sessions.set('alive', { port: 2, pid: process.pid, startedAt: 2 });
  assert.equal(store.sessions.get('dead'), null);
  const file = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
  assert.ok(!('dead' in file));
  assert.deepEqual(store.sessions.get('alive'), { port: 2, pid: process.pid, startedAt: 2 });
  store.sessions.remove('alive');
  assert.equal(store.sessions.get('alive'), null);
});

test('draft ids are unique within a second; save moves the session key; importEvents refuses existing', () => {
  const home = tempHome();
  const store = openStore(home);
  const ids = new Set([store.createDraft(BRIEF, 'a'), store.createDraft(BRIEF, 'b'), store.createDraft(BRIEF, 'c')]);
  assert.equal(ids.size, 3);
  const [first] = [...ids];
  assert.match(first, /^draft-\d{8}-\d{6}/);
  store.append(first, { t: 'ontology.created', at: 0, name: 'a', root: 'r', brief: BRIEF, categories: [] });
  store.sessions.set(first, { port: 3, pid: process.pid, startedAt: 1 });
  store.save(first, 'alpha');
  assert.equal(store.sessions.get('alpha')?.port, 3);
  assert.equal(store.sessions.get(first), null);
  store.importEvents('imp', fixtureEvents('manga'));
  assert.throws(() => store.importEvents('imp', fixtureEvents('manga')), /already exists/);
  assert.equal(store.list().find((r) => r.id === 'imp')?.draft, false);
  assert.ok(store.now('imp') >= 0);
});

test('performance: 100 resolves over 50 index rows take <100 ms and never read a snapshot', () => {
  const home = tempHome();
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push({ id: i === 7 ? 'plastic-modeling' : `topic-${i}`, name: i === 7 ? 'plastic-modeling' : `topic-${i}`, root: 'r', nodes: 3, updatedAt: i, draft: false });
  }
  fs.writeFileSync(path.join(home, 'index.json'), JSON.stringify({ current: null, ontologies: rows }));
  const store = openStore(home);
  const real = fs.readFileSync;
  /** @type {string[]} */
  const touched = [];
  // @ts-ignore spy
  fs.readFileSync = (/** @type {any} */ p, ...rest) => { touched.push(String(p)); return real(p, ...rest); };
  const t0 = performance.now();
  let hit;
  try {
    for (let i = 0; i < 100; i++) hit = store.resolve('pla');
    store.list();
  } finally {
    fs.readFileSync = real;
  }
  const ms = performance.now() - t0;
  assert.equal(hit, 'plastic-modeling');
  assert.ok(ms < 100, `took ${ms} ms`);
  assert.ok(touched.length > 0, 'spy saw reads');
  assert.deepEqual(touched.filter((p) => p.endsWith('snapshot.json') || p.endsWith('events.jsonl')), []);
  // the spy would catch a resolver that did read a snapshot
  const bad = [];
  // @ts-ignore spy
  fs.readFileSync = (/** @type {any} */ p, ...rest) => { bad.push(String(p)); return real(p, ...rest); };
  try { try { fs.readFileSync(path.join(home, 'x', 'snapshot.json')); } catch { /* missing */ } } finally { fs.readFileSync = real; }
  assert.equal(bad.filter((p) => p.endsWith('snapshot.json')).length, 1);
});

test('throttled snapshot and index row are written by flush()', () => {
  const home = tempHome();
  const store = openStore(home);
  const id = store.createDraft(BRIEF, 'n');
  store.append(id, { t: 'ontology.created', at: 0, name: 'n', root: 'r', brief: BRIEF, categories: [] });
  store.append(id, { t: 'node.added', at: 1, node: { id: 'r', label: 'R', parent: null, category: '', depth: 0, summary: '' } });
  store.flush();
  const idx = JSON.parse(fs.readFileSync(path.join(home, 'index.json'), 'utf8'));
  assert.equal(idx.ontologies[0].nodes, 1);
  assert.equal(idx.ontologies[0].root, 'r');
  assert.equal(idx.current, id);
  assert.ok(fs.existsSync(path.join(home, id, 'snapshot.json')));
});
