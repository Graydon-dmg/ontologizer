// @ts-check
// cite(nodeIds): the chatbot's cited nodes stay bright (exactly those, plus links between them),
// always labelled, and the citation survives incoming events until cleared or replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { emphasis, neighborhood, planLabels, LABEL_GEOM } from '../../web/views/graph/math.js';
import { OntoGraph } from '../../web/views/graph/index.js';

const events = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const onto = foldAll(events);
const all = Object.values(onto.nodes);
// a, b and c: three depth-3 siblings (b is the search match, c is neither cited nor matched)
const parent = /** @type {any} */ (all.find((n) => n.depth === 2 && all.filter((m) => m.parent === n.id).length >= 3));
const [a, b, child] = all.filter((n) => n.parent === parent.id);

/** @param {() => void} fn */
const throws = (fn) => { try { fn(); } catch { return true; } return false; };

/** A cited set is exactly the cited ids; their links are bright only between cited ends. */
function citeIsExact(/** @type {typeof emphasis} */ em) {
  const e = /** @type {any} */ (em(null, new Set([a.id, a.parent])));
  assert.deepEqual([...e.nodes].sort(), [a.id, a.parent].sort(), 'only the cited nodes are bright');
  assert.ok(e.link(a.id, a.parent), 'the link between two cited nodes is bright');
  assert.ok(!e.link(child.id, a.parent), 'a link to an uncited node dims');
  assert.equal(em(null, null), null, 'nothing set: nothing dims');
}

test('cite emphasises exactly the cited nodes; catches a cite that brightens neighbours', () => {
  citeIsExact(emphasis);
  /** planted fault: cite treated like highlight (whole neighbourhood bright) */
  const neighbourly = (/** @type {any} */ base, /** @type {Set<string>|null} */ cite) =>
    emphasis(base, cite && new Set([...cite].flatMap((id) => [...neighborhood(id, onto)])));
  assert.ok(throws(() => citeIsExact(neighbourly)));
});

/** With a search highlight active, cited nodes outside it are still bright (cite wins on its nodes). */
function coexists(/** @type {typeof emphasis} */ em) {
  const search = new Set([b.id]);
  const e = /** @type {any} */ (em(search, new Set([a.id])));
  assert.ok(e.nodes.has(a.id), 'cited node bright');
  assert.ok(e.nodes.has(b.id), 'search match still bright');
  assert.ok(!e.nodes.has(child.id), 'everything else dims');
}

test('cite coexists with a search highlight; catches a search highlight that hides cited nodes', () => {
  coexists(emphasis);
  /** planted fault: the search highlight replaces the citation */
  assert.ok(throws(() => coexists((base, cite) => emphasis(base, base ? null : cite))));
});

/** Cited labels bypass culling: six cited labels stacked on one spot (more than the four spots) are all drawn. */
function citedLabelsAlwaysDrawn(/** @type {boolean} */ citedFlags) {
  const es = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'c' + i, forced: citedFlags, must: citedFlags, priority: 4, depth: 3, r: 6,
    cx: 100, cy: 100 + i, R: 6, w: LABEL_GEOM.charW * 12, aw: 0 }));
  const out = planLabels(es);
  for (const e of es) assert.ok(out.has(e.id), `${e.id} label drawn`);
}

test('cited labels are never culled; catches cited labels left to the culling', () => {
  citedLabelsAlwaysDrawn(true);
  assert.ok(throws(() => citedLabelsAlwaysDrawn(false)));
});

/** A <onto-graph> with every drawing step stubbed out, so apply() and cite() run for real in Node. */
function bareView(/** @type {typeof OntoGraph} */ Cls) {
  const v = /** @type {any} */ (new Cls());
  const noop = () => {};
  for (const m of ['ensureNode', 'ensureEdge', 'centerWorld', 'refreshRadii', 'updateVisibility', 'refreshRings',
    'syncGhost', 'syncGhosts', 'restyle', 'setFocus', 'setLens', 'onJob', 'schedule']) v[m] = noop;
  v.dims = [];
  v.applyDim = () => v.dims.push(v.cited ? [...v.cited].sort() : null);
  v.ctx = { snapshot: () => onto, emit: noop, layout: { positions: () => new Map() } };
  return v;
}

const incoming = [
  { t: 'node.added', node: a },
  { t: 'node.updated', id: a.id, patch: {} },
  { t: 'edge.added', edge: { id: 'e1', from: a.id, to: b.id, type: 'related' } },
  { t: 'view.changed', patch: { focus: a.id } },
  { t: 'view.changed', patch: { lens: null, filter: { categories: null, maxDepth: 1 } } },
  { t: 'job.started', job: { id: 'j1', kind: 'research', nodeId: a.id } },
  { t: 'lens.analog', lensId: 'x', nodeId: a.id, label: 'y' },
  { t: 'chat.answered', chatId: 'main', msgId: 'm1', replyTo: 'u1', text: 'hi', citations: [] },
];

/** The citation outlives every kind of incoming event, and each event re-dims what it drew. */
function survives(/** @type {typeof OntoGraph} */ Cls) {
  const v = bareView(Cls);
  v.cite([a.id, b.id]);
  for (const ev of incoming) {
    v.dims = [];
    v.apply(ev);
    assert.deepEqual(v.cited && [...v.cited].sort(), [a.id, b.id].sort(), `citation kept after ${ev.t}`);
    assert.deepEqual(v.dims.at(-1), [a.id, b.id].sort(), `${ev.t}: new drawing dimmed around the citation`);
  }
  // cited labels are always candidates, forced, top priority, even a deep node at zoom 1
  v.nodes = new Map(all.map((n) => [n.id, {}]));
  v.refreshLabels = OntoGraph.prototype.refreshLabels;
  v.refreshLabels();
  assert.equal(v.labelWanted.get(a.id), true, 'cited label wanted and forced');
  assert.equal(v.labelPriority.get(a.id), 4, 'cited label first in line');
  v.cite(null);
  assert.equal(v.cited, null, 'null clears');
  v.highlight([b.id]);
  assert.equal(v.cited, null, 'highlight() leaves the citation alone');
}

test('a citation survives incoming events until cleared; catches one wiped by the next event', () => {
  survives(OntoGraph);
  /** planted fault: any incoming event resets the emphasis */
  class Wiped extends OntoGraph {
    /** @param {any} ev */
    apply(ev) { this.cited = null; super.apply(ev); }
  }
  assert.ok(throws(() => survives(Wiped)));
});
