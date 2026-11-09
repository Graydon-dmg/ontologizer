// @ts-check
// Live search opens the branches that hide a match (createReveal): only once typing pauses or on
// Enter, never twice for a node still waiting to open, and silently not at all once the page
// cannot change the map (a read-only token). With planted faults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll, fold } from '../../src/core/events.js';
import { searchNodes, createReveal, REVEAL_DELAY_MS } from '../../web/shell/search.js';

const base = foldAll(readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const deep = /** @type {any} */ (Object.values(base.nodes).find((n) => n.depth === 3));
const parent = deep.parent;
const grand = base.nodes[parent].parent;
const collapsedMap = fold(base, { t: 'view.changed', at: 0, patch: { collapsed: [grand, parent] } });

/** A fake clock and a recording source. @param {{ snap?: any, reply?: any }} [o] */
function rig({ snap = collapsedMap, reply = { ok: true } } = {}) {
  /** @type {{ fn: () => void, ms: number }|null} */
  let timer = null;
  /** @type {string[]} */
  const sent = [];
  const reveal = createReveal({
    snapshot: () => snap, // stale between keystrokes, like the real page before the event lands
    act: (a) => { sent.push(a.nodeId); return reply; },
    setTimer: (fn, ms) => { timer = { fn, ms }; return timer; },
    clearTimer: (t) => { if (timer === t) timer = null; },
  });
  const flushTimer = async () => { const t = timer; timer = null; if (t) t.fn(); await new Promise((r) => setImmediate(r)); };
  const settle = () => new Promise((r) => setImmediate(r));
  return { reveal, sent, flushTimer, settle, pending: () => timer };
}

/** Typing a label one letter at a time. @param {ReturnType<typeof rig>} r @param {string} text */
function type(r, text) {
  for (let i = 1; i <= text.length; i++) r.reveal.schedule(searchNodes(collapsedMap, text.slice(0, i)));
}

test('typing sends nothing until it pauses; then each hidden branch opens once, shallowest first', async () => {
  const r = rig();
  type(r, deep.label);
  await r.settle();
  assert.deepEqual(r.sent, [], 'nothing per keystroke');
  assert.equal(r.pending()?.ms, REVEAL_DELAY_MS);
  await r.flushTimer();
  assert.deepEqual(r.sent.slice(0, 2), [grand, parent]);
  assert.equal(new Set(r.sent).size, r.sent.length, 'no node twice');
});

test('a stale snapshot does not re-send: typing more, Enter, and a second pause send nothing new', async () => {
  const r = rig();
  type(r, deep.label);
  await r.flushTimer();
  const first = r.sent.length;
  type(r, deep.label); // same matches, the snapshot still shows them collapsed
  await r.flushTimer();
  r.reveal.now(searchNodes(collapsedMap, deep.label));
  await r.settle();
  assert.equal(r.sent.length, first);
});

test('Enter opens at once, without waiting for the pause, and cancels the pending one', async () => {
  const r = rig();
  type(r, deep.label);
  r.reveal.now(searchNodes(collapsedMap, deep.label));
  await r.settle();
  assert.deepEqual(r.sent.slice(0, 2), [grand, parent]);
  assert.equal(r.pending(), null);
});

test('a refused expand (read-only token) stops this session trying, and nothing throws', async () => {
  const r = rig({ reply: { ok: false, error: 'HTTP 403' } });
  type(r, deep.label);
  await r.flushTimer();
  const tried = r.sent.length;
  assert.ok(tried > 0);
  assert.equal(r.reveal.stopped(), true);
  const other = /** @type {any} */ (Object.values(base.nodes).find((n) => n.depth === 2 && n.parent !== parent && n.id !== parent));
  const snap2 = fold(collapsedMap, { t: 'view.changed', at: 0, patch: { collapsed: [grand, parent, other.parent] } });
  r.reveal.now(searchNodes(snap2, other.label));
  r.reveal.schedule(searchNodes(snap2, other.label));
  await r.settle();
  assert.equal(r.sent.length, tried, 'no more expands after the refusal');
  assert.equal(r.pending(), null);
});

test('an expand that landed is forgotten: the user closes the branch again, a later search reopens it', async () => {
  let snap = collapsedMap;
  /** @type {string[]} */
  const sent = [];
  const reveal = createReveal({ snapshot: () => snap, act: (a) => { sent.push(a.nodeId); return { ok: true }; }, setTimer: () => 0, clearTimer: () => {} });
  reveal.now([deep.id]);
  snap = fold(snap, { t: 'view.changed', at: 0, patch: { collapsed: [] } }); // landed
  reveal.now([deep.id]);
  assert.deepEqual(sent, [grand, parent]);
  snap = fold(snap, { t: 'view.changed', at: 0, patch: { collapsed: [grand] } }); // closed again
  reveal.now([deep.id]);
  assert.deepEqual(sent, [grand, parent, grand]);
});

test('planted fault: the old per-keystroke reveal sends the same expands again and again', () => {
  /** @type {string[]} */
  const sent = [];
  const label = String(deep.label);
  // what 1.3.0 did: expand every collapsed ancestor of every match on each input event
  for (let i = 1; i <= label.length; i++) {
    for (const id of searchNodes(collapsedMap, label.slice(0, i))) {
      for (let p = collapsedMap.nodes[id]?.parent; p != null; p = collapsedMap.nodes[p]?.parent) if (collapsedMap.view.collapsed.includes(p)) sent.push(p);
    }
  }
  assert.ok(sent.length > new Set(sent).size, 'the planted version repeats itself');
});

test('reviewer case: search, clear, close by hand, search again reopens (no pause in between)', () => {
  let snap = collapsedMap;
  /** @type {string[]} */
  const sent = [];
  const reveal = createReveal({ snapshot: () => snap, act: (a) => { sent.push(a.nodeId); return { ok: true }; }, setTimer: () => 0, clearTimer: () => {} });
  reveal.now([deep.id]); // search: asks grand and parent to open
  reveal.schedule([]); // the user clears the search (the expand lands meanwhile, never observed)
  snap = fold(snap, { t: 'view.changed', at: 0, patch: { collapsed: [grand] } }); // and closes grand by hand
  reveal.now([deep.id]); // same search again
  assert.deepEqual(sent, [grand, parent, grand]);
  reveal.reset(); // Escape also starts fresh
  reveal.now([deep.id]);
  assert.deepEqual(sent, [grand, parent, grand, grand]);
});
