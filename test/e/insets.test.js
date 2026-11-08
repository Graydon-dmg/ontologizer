// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerRect, readInsets, fitTransform, resizeTransform } from '../../web/views/graph/math.js';

const OPT = { minK: 0.2, maxK: 2.2, margin: 0.88 };
const B = { minX: 0, minY: 0, maxX: 1000, maxY: 800 };
const VIEW = { width: 900, height: 700 };
const css = { '--onto-inset-top': '56px', '--onto-inset-right': '0px', '--onto-inset-bottom': '', '--onto-inset-left': '240px' };

/** The fitted map lies inside the free area left by the insets (e.g. the legend / explain panel). */
function fitsInsideInsets(/** @type {typeof innerRect} */ inner) {
  const ins = readInsets((n) => /** @type {any} */ (css)[n] ?? '');
  assert.deepEqual(ins, { top: 56, right: 0, bottom: 0, left: 240 });
  const r = inner(VIEW, ins);
  const t = /** @type {any} */ (fitTransform(B, r, OPT));
  assert.ok(t.x >= 240 - 1e-6, 'map starts right of the left inset');
  assert.ok(t.y >= 56 - 1e-6, 'map starts below the top inset');
  assert.ok(t.x + 1000 * t.k <= 900 + 1e-6 && t.y + 800 * t.k <= 700 + 1e-6, 'map ends inside the view');
  // panel closes (insets change) after the user moved: the same map point stays at the free area's centre
  const moved = { x: 100, y: 80, k: 1.2 };
  const r2 = inner(VIEW, { top: 56, right: 0, bottom: 0, left: 0 });
  const t2 = /** @type {any} */ (resizeTransform(moved, r, r2, true, B, OPT));
  const c = (/** @type {any} */ tt, /** @type {any} */ rr) => [(rr.x + rr.width / 2 - tt.x) / tt.k, (rr.y + rr.height / 2 - tt.y) / tt.k];
  assert.deepEqual(c(t2, r2).map(Math.round), c(moved, r).map(Math.round));
}

test('fit and resize stay inside the shell insets; catches insets ignored', () => {
  fitsInsideInsets(innerRect);
  assert.throws(() => fitsInsideInsets((size) => ({ x: 0, y: 0, ...size })), 'planted fault: insets ignored');
});

test('readInsets defaults to 0; innerRect ignores insets that leave too little room', () => {
  assert.deepEqual(readInsets(() => ''), { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(innerRect({ width: 400, height: 300 }, { top: 0, right: 200, bottom: 0, left: 150 }), { x: 0, y: 0, width: 400, height: 300 });
});
