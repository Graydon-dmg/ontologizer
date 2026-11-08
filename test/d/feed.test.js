// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { feedLayout } from '../../web/shell/feed.js';
import { parseJsonl } from '../../web/shell/source.js';
import { createGraphLayout } from '../../web/shared/layout/graph.js';

const fixturePath = fileURLToPath(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url));
const fixture = parseJsonl(readFileSync(fixturePath, 'utf8'));

// Move each child ahead of its parent so some nodes arrive before their parent.
function shuffled() {
  const evs = fixture.slice();
  for (let i = 1; i < evs.length; i++) {
    if (evs[i].t === 'node.added' && evs[i - 1].t === 'node.added' && evs[i].node.parent === evs[i - 1].node.id) {
      [evs[i - 1], evs[i]] = [evs[i], evs[i - 1]];
    }
  }
  return evs;
}

/** @param {(layout: any, e: any) => void} feeder */
function check(feeder) {
  const layout = createGraphLayout({ seed: 1 });
  const evs = shuffled();
  try {
    for (const e of evs) feeder(layout, e);
    layout.settle(50);
  } finally {
    layout.stop();
  }
  const ids = evs.filter((e) => e.t === 'node.added').map((e) => e.node.id);
  const pos = layout.positions();
  for (const id of ids) {
    const p = pos.get(id);
    assert.ok(p && Number.isFinite(p.x) && Number.isFinite(p.y), `missing or NaN position for ${id}`);
  }
  assert.equal(pos.size, new Set(ids).size, 'each node exactly once');
}

test('feeding the fixture through the layout feeder leaves every node in positions(), each exactly once', () => {
  check(feedLayout);
});

test('planted fault: a feeder that skips node.added for orphans is caught', () => {
  /** @type {Set<string>} */
  const seen = new Set();
  const bad = (/** @type {any} */ layout, /** @type {any} */ e) => {
    if (e.t === 'node.added') {
      seen.add(e.node.id);
      if (e.node.parent && !seen.has(e.node.parent)) return;
    }
    feedLayout(layout, e);
  };
  assert.throws(() => check(bad));
});

test('view.changed feeds collapsed and focus; other events do not touch the layout', () => {
  /** @type {any[]} */
  const calls = [];
  const fake = {
    add: (/** @type {any} */ n) => calls.push(['add', n.id]),
    addEdge: (/** @type {any} */ e) => calls.push(['addEdge', e.id]),
    setCollapsed: (/** @type {any} */ ids) => calls.push(['setCollapsed', ids]),
    setFocus: (/** @type {any} */ id) => calls.push(['setFocus', id]),
  };
  feedLayout(fake, { t: 'view.changed', at: 0, patch: { collapsed: ['a'], focus: 'b' } });
  feedLayout(fake, { t: 'view.changed', at: 0, patch: { lens: 'x' } });
  feedLayout(fake, { t: 'node.updated', at: 0, id: 'a', patch: {} });
  feedLayout(fake, { t: 'edge.added', at: 0, edge: { id: 'e1' } });
  assert.deepEqual(calls, [['setCollapsed', ['a']], ['setFocus', 'b'], ['addEdge', 'e1']]);
});
