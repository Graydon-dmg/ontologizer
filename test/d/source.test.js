// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSource, parseJsonl } from '../../web/shell/source.js';
import { foldAll, fold, emptyOntology } from '../../src/core/events.js';
import { ACTION_TYPES, isValidAction } from '../../web/shell/actions.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url));
const base = parseJsonl(readFileSync(fixturePath, 'utf8'));
// The fixture has no node.updated: add some so a source that skips them is caught.
const events = [
  ...base,
  { t: 'node.updated', at: 30000, id: 'plastic-modeling/tools', patch: { summary: 'updated summary' } },
  { t: 'node.updated', at: 30001, id: 'plastic-modeling', patch: { status: 'done' } },
];
const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const fakeFetch = /** @type {any} */ (async (/** @type {string} */ url) => {
  assert.equal(url, '/fixtures/plastic-modeling.events.jsonl');
  return { ok: true, status: 200, text: async () => jsonl };
});
const now = (/** @type {() => void} */ fn) => { fn(); };

test('fixture mode replays the whole fixture and its snapshot equals foldAll of the fixture', async () => {
  const src = createSource({ search: '?fixture=plastic-modeling&speed=4', fetch: fakeFetch, setTimeout: now });
  assert.equal(src.mode, 'fixture');
  let seen = 0;
  src.subscribe(() => { seen++; });
  await src.done;
  assert.equal(seen, events.length);
  assert.deepEqual(src.snapshot(), foldAll(events));
  assert.equal(src.snapshot().nodes['plastic-modeling/tools'].summary, 'updated summary');
});

test('planted fault: a source that skips node.updated fails the replay check', async () => {
  const skipping = events.filter((e) => e.t !== 'node.updated');
  assert.notDeepEqual(foldAll(skipping), foldAll(events));
});

test('fixture mode paces by at / speed', async () => {
  /** @type {number[]} */
  const waits = [];
  const src = createSource({
    search: '?fixture=plastic-modeling&speed=4', fetch: fakeFetch,
    setTimeout: (fn, ms) => { waits.push(ms); fn(); },
  });
  await src.done;
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - events[events.length - 1].at / 4) < 1, `total ${total}`);
});

test('fixture act(): view actions become local view.changed; job actions queue then finish', async () => {
  /** @type {(() => void)[]} */
  const pending = [];
  const src = createSource({
    search: '?fixture=plastic-modeling', fetch: fakeFetch, jobDelayMs: 1000,
    setTimeout: (fn, ms) => { if (ms === 1000) pending.push(fn); else fn(); },
    speed: 1e6,
  });
  await src.done;
  /** @type {any[]} */
  const got = [];
  src.subscribe((e) => got.push(e));
  await src.act({ type: 'collapse', nodeId: 'plastic-modeling/tools' });
  assert.deepEqual(src.snapshot().view.collapsed, ['plastic-modeling/tools']);
  await src.act({ type: 'expand', nodeId: 'plastic-modeling/tools' });
  assert.deepEqual(src.snapshot().view.collapsed, []);
  await src.act({ type: 'filter', value: { maxDepth: 2 } });
  assert.deepEqual(src.snapshot().view.filter, { categories: null, maxDepth: 2 });
  await src.act({ type: 'lens', value: null });
  assert.equal(src.snapshot().view.lens, null);
  const r = await src.act({ type: 'explain', nodeId: 'plastic-modeling/tools' });
  assert.equal(r.ok, true);
  const job = src.snapshot().jobs[r.jobId];
  assert.equal(job.state, 'queued');
  assert.equal(job.nodeId, 'plastic-modeling/tools');
  pending.forEach((f) => f());
  assert.equal(src.snapshot().jobs[r.jobId].state, 'done');
  assert.ok(got.every((e) => e.t === 'view.changed' || e.t.startsWith('job.')));
  const bad = await src.act({ type: 'explainNode', nodeId: 'x' });
  assert.equal(bad.ok, false);
});

// A fake EventSource that replays the given server log from ?from=n, like Epic B's /api/events.
function fakeServer(/** @type {any[]} */ log) {
  /** @type {string[]} */
  const opened = [];
  class FakeES {
    /** @param {string} url */
    constructor(url) {
      opened.push(url);
      this.url = url;
      /** @type {any} */ this.onmessage = null;
      /** @type {any} */ this.onerror = null;
      this.closed = false;
      FakeES.last = this;
    }
    close() { this.closed = true; }
    /** @param {number} upto */
    deliver(upto) {
      const from = Number(new URL(this.url, 'http://x').searchParams.get('from'));
      for (let i = from; i < upto && !this.closed; i++) this.onmessage({ data: JSON.stringify(log[i]) });
    }
  }
  /** @type {any} */ FakeES.last = null;
  return { FakeES, opened };
}

test('server mode folding a replayed stream from 0 equals foldAll, nothing counted twice (even across a reconnect)', () => {
  const { FakeES, opened } = fakeServer(events);
  /** @type {(() => void)[]} */
  const timers = [];
  const src = createSource({ search: '', EventSource: FakeES, setTimeout: (fn) => { timers.push(fn); } });
  assert.equal(src.mode, 'server');
  assert.equal(opened[0], '/api/events?from=0');
  FakeES.last.deliver(40);
  FakeES.last.onerror(); // connection drops
  timers.shift()?.();
  assert.equal(opened[1], '/api/events?from=40');
  FakeES.last.deliver(events.length);
  const want = foldAll(events);
  assert.deepEqual(src.snapshot(), want);
  assert.equal(src.snapshot().categories.length, want.categories.length);
  assert.equal(src.snapshot().insights.length, 2);
});

test('planted fault: starting from /api/snapshot and then streaming from 0 double-counts', () => {
  // What a source that seeds from the snapshot would end with.
  let o = foldAll(events); // the snapshot
  for (const e of events) o = fold(o, e); // then the stream from 0
  const want = foldAll(events);
  assert.throws(() => assert.equal(o.insights.length, want.insights.length));
  assert.notDeepEqual(o, want);
});

test('server act() POSTs the action to /api/action as JSON', async () => {
  const { FakeES } = fakeServer([]);
  /** @type {any[]} */
  const posts = [];
  const src = createSource({
    search: '', EventSource: FakeES,
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
      posts.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, jobId: 'j1' }) };
    }),
  });
  const r = await src.act({ type: 'research', nodeId: 'a', mode: 'general' });
  assert.deepEqual(r, { ok: true, jobId: 'j1' });
  assert.equal(posts[0].url, '/api/action');
  assert.equal(posts[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(posts[0].init.body), { type: 'research', nodeId: 'a', mode: 'general' });
  assert.deepEqual(emptyOntology(), src.snapshot());
});

test('ACTION_TYPES are exactly Epic B\'s /api/action types', () => {
  assert.deepEqual([...ACTION_TYPES].sort(),
    ['collapse', 'expand', 'explain', 'filter', 'focus', 'layout', 'lens', 'research', 'sources']);
  assert.equal(isValidAction({ type: 'explainNode', nodeId: 'a' }), false);
  assert.equal(isValidAction({ type: 'research', nodeId: 'a', mode: 'wide' }), false);
  assert.equal(isValidAction({ type: 'lens', value: null }), true);
});
