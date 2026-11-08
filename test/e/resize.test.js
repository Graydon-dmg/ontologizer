// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeTransform, isUserMove } from '../../web/views/graph/math.js';

const OPT = { minK: 0.2, maxK: 2.2, margin: 0.88 };
const B = { minX: 0, minY: 0, maxX: 1000, maxY: 800 }; // a settled map
const center = (/** @type {any} */ t, /** @type {any} */ box) => ({ x: (box.width / 2 - t.x) / t.k, y: (box.height / 2 - t.y) / t.k });

/** Build settled, fitted at 1440x900; the window is resized to 900x700 and then 1920x1080. */
function resizeAfterSettle(/** @type {typeof resizeTransform} */ rt) {
  let box = { width: 1440, height: 900 };
  let t = /** @type {any} */ (rt({ x: 0, y: 0, k: 1 }, { width: 0, height: 0 }, box, false, B, OPT));
  for (const next of [{ width: 900, height: 700 }, { width: 1920, height: 1080 }]) {
    t = rt(t, box, next, false, B, OPT);
    box = next;
    // the whole map is inside the view and centered
    assert.ok(t.x >= -1e-6 && t.y >= -1e-6 && t.x + 1000 * t.k <= box.width + 1e-6 && t.y + 800 * t.k <= box.height + 1e-6, 'map fits the new size');
    const c = center(t, box);
    assert.ok(Math.abs(c.x - 500) < 1e-6 && Math.abs(c.y - 400) < 1e-6, 'map centered');
  }
  // after the user pans: same map point stays at the center, same zoom
  const moved = { x: -300, y: -120, k: 1.3 };
  const was = center(moved, box);
  const t2 = /** @type {any} */ (rt(moved, box, { width: 1000, height: 600 }, true, B, OPT));
  const now = center(t2, { width: 1000, height: 600 });
  assert.equal(t2.k, 1.3);
  assert.ok(Math.abs(now.x - was.x) < 1e-6 && Math.abs(now.y - was.y) < 1e-6, 'center point kept');
}

test('resize after the build settles refits (or keeps the center once the user moved); catches a resize that keeps the old transform', () => {
  resizeAfterSettle(resizeTransform);
  /** planted fault: once the build has settled, a resize leaves the transform as it was */
  const stale = (/** @type {any} */ t, /** @type {any} */ p, /** @type {any} */ b, /** @type {boolean} */ u, /** @type {any} */ bd, /** @type {any} */ o) =>
    (p.width > 0 ? t : resizeTransform(t, p, b, u, bd, o));
  assert.throws(() => resizeAfterSettle(/** @type {any} */ (stale)));
});

test('a click with jitter is not a user move; a real pan or zoom is; catches "any zoom event counts"', () => {
  const check = (/** @type {typeof isUserMove} */ f) => {
    const s = { x: 10, y: 10, k: 1 };
    assert.equal(f(s, { x: 12, y: 11, k: 1 }, 4), false, '2px jitter is a click');
    assert.equal(f(s, { x: 40, y: 10, k: 1 }, 4), true, 'a pan');
    assert.equal(f(s, { x: 10, y: 10, k: 1.1 }, 4), true, 'a zoom');
  };
  check(isUserMove);
  assert.throws(() => check(() => true), 'planted fault: every zoom event marks the user as moved');
});
