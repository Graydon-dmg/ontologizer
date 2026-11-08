// @ts-check
// The auto-fit leaves room for labels (drawn at a constant screen size) on both sides, so a label
// on the leftmost or rightmost node stays inside the free area.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitBox, fitTransform, innerRect, planLabels, spotBoxes, LABEL_GEOM } from '../../web/views/graph/math.js';

const opt = { minK: 0.2, maxK: 2.2, margin: 0.88 };
const LABEL = 64; // px, e.g. "Tweezers" (longer labels flip inward: see the planLabels test below)

/** 700 px wide with the chat panel open: the legend inset is dropped, the map fits left of the panel. */
function labelsInside(/** @type {typeof fitBox} */ box) {
  const rect = innerRect({ width: 700, height: 900 }, { top: 125, right: 378, bottom: 95, left: 196 });
  const b = { minX: -400, minY: -300, maxX: 400, maxY: 300 }; // node dots of a wide map
  const t = /** @type {any} */ (fitTransform(b, box(rect, LABEL), opt));
  const left = b.minX * t.k + t.x - LABEL, right = b.maxX * t.k + t.x + LABEL; // left label of the leftmost dot, right label of the rightmost
  assert.ok(left >= rect.x - 0.5, `left label clipped: ${left.toFixed(1)} < ${rect.x}`);
  assert.ok(right <= rect.x + rect.width + 0.5, `right label under the panel: ${right.toFixed(1)} > ${rect.x + rect.width}`);
}

test('the fit keeps edge labels inside the free area at 700 px; catches a fit that ignores label width', () => {
  labelsInside(fitBox);
  /** planted fault: fit the dots to the bare free area (the old behaviour) */
  assert.throws(() => labelsInside((r) => r));
});

test('fitBox never takes more than 22% per side', () => {
  const r = fitBox({ x: 0, y: 0, width: 300, height: 400 }, 500);
  assert.equal(r.x, 66);
  assert.equal(r.width, 168);
});

/** A left-edge node whose label last sat on its left (spot 1) flips to the right instead of leaving the screen;
 *  a node by the chat panel puts its label on its left instead of under the panel. */
function staysInArea(/** @type {(es: any[]) => Map<string, { spot: number }>} */ plan) {
  const area = { x: 0, y: 125, width: 322, height: 680 };
  const w = LABEL_GEOM.charW * 'Weathering Techniques'.length;
  const es = [
    { id: 'left', forced: false, depth: 2, r: 6, cx: 20, cy: 300, R: 6, w, aw: 0, prev: 1 },
    { id: 'right', forced: true, depth: 1, r: 8, cx: 300, cy: 500, R: 8, w, aw: 0, prev: 0 },
  ];
  const out = plan(es);
  for (const e of es) {
    const at = out.get(e.id);
    assert.ok(at, `${e.id} drawn`);
    const b = spotBoxes(e, false)[/** @type {any} */ (at).spot];
    assert.ok(b.x >= area.x && b.x + b.w <= area.x + area.width, `${e.id} label inside the free area (x ${b.x.toFixed(0)}..${(b.x + b.w).toFixed(0)})`);
  }
}

test('edge labels flip inward instead of leaving the screen or running under a panel; catches placement without the area', () => {
  staysInArea((es) => planLabels(es, spotBoxes, { x: 0, y: 125, width: 322, height: 680 }));
  /** planted fault: the old placement, which knows nothing of the free area */
  assert.throws(() => staysInArea((es) => planLabels(es)));
});
