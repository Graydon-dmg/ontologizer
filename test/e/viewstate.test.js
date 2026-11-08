// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncViewState, fitTransform } from '../../web/views/graph/math.js';

const NONE = { categories: null, maxDepth: null };

/** Mount, setFilter({maxDepth:1}) locally, then 5 streamed events whose snapshot filter is unchanged. */
function filterSurvivesStream(/** @type {typeof syncViewState} */ sync) {
  let { local, seen } = sync({ filter: NONE, collapsed: [] }, { filter: '', collapsed: '' }, { filter: NONE, collapsed: [] });
  local = { ...local, filter: { categories: null, maxDepth: 1 } }; // setFilter
  for (let i = 0; i < 5; i++) ({ local, seen } = sync(local, seen, { filter: NONE, collapsed: [] }));
  assert.deepEqual(local.filter, { categories: null, maxDepth: 1 }, 'local filter survives events');
  // a real view.changed that changes the stored filter is adopted
  ({ local, seen } = sync(local, seen, { filter: { categories: null, maxDepth: 2 }, collapsed: ['a'] }));
  assert.deepEqual(local.filter, { categories: null, maxDepth: 2 });
  assert.deepEqual(local.collapsed, ['a']);
}

test('a filter set with setFilter survives streamed events; catches a sync that copies the snapshot every update', () => {
  filterSurvivesStream(syncViewState);
  /** planted fault: rebuild from the snapshot on every update */
  const everyUpdate = (/** @type {any} */ l, /** @type {any} */ s, /** @type {any} */ v) =>
    ({ local: { filter: { ...NONE, ...(v?.filter || {}) }, collapsed: v?.collapsed ?? [] }, seen: s, changed: true });
  assert.throws(() => filterSurvivesStream(/** @type {any} */ (everyUpdate)));
});

const OPT = { minK: 0.2, maxK: 2.5, margin: 0.9 };
const B = { minX: -400, minY: -250, maxX: 400, maxY: 250 };

/** A 0x0 mount gives no transform; once the element has a real size the fit centers the bounds. */
function zeroThenResize(/** @type {typeof fitTransform} */ fit) {
  assert.equal(fit(B, { width: 0, height: 0 }, OPT), null, '0x0 mount: no fit yet');
  const t = fit(B, { width: 800, height: 600 }, OPT);
  assert.ok(t && Number.isFinite(t.k) && t.k > 0.5, 'fits after resize');
  assert.ok(Math.abs(t.x + t.k * 0 - 400) < 1e-9 && Math.abs(t.y - 300) < 1e-9, 'bounds centered');
  const t2 = fit(B, { width: 1600, height: 1000 }, OPT);
  assert.ok(t2 && t2.k > t.k, 'a bigger window zooms in further');
}

test('fitTransform: 0x0 mount then resize; catches a fit computed against a 0x0 box', () => {
  zeroThenResize(fitTransform);
  /** planted fault: no zero-size guard (k collapses to minK and sticks at the corner) */
  const unguarded = (/** @type {any} */ b, /** @type {any} */ box, /** @type {any} */ o) =>
    fitTransform(b, { width: Math.max(box.width, 1e-9), height: Math.max(box.height, 1e-9) }, o);
  assert.throws(() => zeroThenResize(unguarded));
});
