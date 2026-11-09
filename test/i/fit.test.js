// @ts-check
// fitPanel keeps a floating panel fully inside the window at every size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPanel, outside } from '../../web/shell/fit.js';

const SIZES = [[320, 640], [375, 812], [768, 1024], [1024, 768], [1280, 800], [200, 150]];
/** Anchors across the top bar (left, middle, right), one low (a wrapped bar), one at the bottom. */
const anchors = (/** @type {number} */ w, /** @type {number} */ h) => [
  { left: 8, top: 8, right: 60, bottom: 30 },
  { left: w / 2 - 20, top: 8, right: w / 2 + 20, bottom: 30 },
  { left: w - 70, top: 8, right: w - 8, bottom: 30 },
  { left: 10, top: h * 0.6, right: 80, bottom: h * 0.6 + 22 },
  { left: w - 60, top: h - 30, right: w - 8, bottom: h - 8 },
];
const PANELS = [{ width: 300, height: 260 }, { width: 480, height: 900 }, { width: 120, height: 80 }, { width: 2000, height: 2000 }];

/**
 * Every placement, rendered at its capped size, inside the window less the 8 px margin.
 * @param {typeof fitPanel} fit @returns {string[]}
 */
function placementProblems(fit) {
  const problems = [];
  for (const [w, h] of SIZES) {
    for (const a of anchors(w, h)) {
      for (const panel of PANELS) {
        const p = fit(a, panel, { w, h });
        const box = { left: p.left, top: p.top, width: Math.min(panel.width, p.maxWidth), height: Math.min(panel.height, p.maxHeight) };
        for (const x of outside(box, { w, h }, 8)) problems.push(`${w}x${h} anchor ${JSON.stringify(a)} panel ${panel.width}x${panel.height}: ${x}`);
      }
    }
  }
  return problems;
}

test('fitPanel keeps every panel inside the window (8 px margin) at every size and anchor', () => {
  assert.deepEqual(placementProblems(fitPanel), []);
});

test('planted fault: a placement that ignores the left edge (right-aligned to its button, no clamp) is reported', () => {
  /** @type {typeof fitPanel} */
  const rightAligned = (a, panel, vp) => ({ left: a.right - panel.width, top: a.bottom + 6, maxWidth: vp.w, maxHeight: vp.h - a.bottom - 14 });
  const problems = placementProblems(rightAligned);
  assert.ok(problems.some((p) => p.includes('320x640') && /left -?\d+ < 8/.test(p)), 'the narrow-window left overflow is caught');
});

test('fitPanel: a small panel sits right under its button, right edges lined up; width and height caps only when needed', () => {
  const p = fitPanel({ left: 900, top: 10, right: 960, bottom: 34 }, { width: 300, height: 200 }, { w: 1280, h: 800 });
  assert.deepEqual(p, { left: 660, top: 40, maxWidth: 1264, maxHeight: 752 });
  const narrow = fitPanel({ left: 10, top: 10, right: 70, bottom: 34 }, { width: 300, height: 200 }, { w: 320, h: 640 });
  assert.equal(narrow.left, 8);
  const tiny = fitPanel({ left: 10, top: 10, right: 70, bottom: 34 }, { width: 300, height: 200 }, { w: 200, h: 640 });
  assert.equal(tiny.maxWidth, 184); // wider than the window: capped, scrolls inside
});
