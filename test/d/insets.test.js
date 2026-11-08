// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInsets, sameInsets } from '../../web/shell/insets.js';

const VP = { w: 900, h: 800 };
const bar = { left: 10, top: 10, right: 680, bottom: 80 };
const legendOpen = { left: 10, top: 88, right: 170, bottom: 290 };
const legendCollapsed = { left: 10, top: 88, right: 90, bottom: 112 };
const minimap = { left: 690, top: 10, right: 890, bottom: 160 };
const explain = { left: 500, top: 170, right: 890, bottom: 740 };

/** @param {typeof computeInsets} f */
function check(f) {
  // Bar + open legend + minimap: the legend takes the left, the top clears bar and minimap.
  const a = f(VP, [bar, legendOpen, minimap]);
  assert.equal(a.left, 178);
  assert.ok(a.top >= 88, `top ${a.top}`);
  // Collapsing the legend frees the left edge.
  const b = f(VP, [bar, legendCollapsed, minimap]);
  assert.equal(b.left, 0);
  assert.ok(b.top >= 120);
  // Opening the explain panel takes the right.
  const c = f(VP, [bar, legendOpen, minimap, explain]);
  assert.equal(c.right, 408);
  // No panels, no insets.
  assert.deepEqual(f(VP, []), { top: 0, right: 0, bottom: 0, left: 0 });
}

test('insets cover the bar, legend, minimap and open explain panel, and follow legend collapse', () => {
  check(computeInsets);
  assert.equal(sameInsets(null, { top: 0, right: 0, bottom: 0, left: 0 }), false);
});

test('planted fault: insets that ignore the side panels (top bar only) are caught', () => {
  const barOnly = (/** @type {any} */ vp, /** @type {any[]} */ rects) => ({ top: rects.length ? 88 : 0, right: 0, bottom: 0, left: 0 });
  assert.throws(() => check(/** @type {any} */ (barOnly)));
});

test('the jobs tray counts too: bottom or right, whichever costs less', () => {
  const tray = { left: 640, top: 760, right: 890, bottom: 890 };
  const vp = { w: 900, h: 900 };
  const ins = computeInsets(vp, [{ left: 10, top: 10, right: 680, bottom: 80 }, tray]);
  assert.ok(ins.bottom >= 148 || ins.right >= 268, JSON.stringify(ins));
  // planted fault: ignoring the tray leaves a node under it
  const bad = computeInsets(vp, [{ left: 10, top: 10, right: 680, bottom: 80 }]);
  assert.throws(() => assert.ok(bad.bottom >= 148 || bad.right >= 268));
});
