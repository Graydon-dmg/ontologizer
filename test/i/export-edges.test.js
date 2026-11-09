// @ts-check
// Popovers stay inside the window (the Export menu) or the element (the embed's details panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeMenu, EDGE } from '../../web/shell/ui/export.js';
import { panelBelowBar } from '../../web/embed/helpers.js';

/** @param {{ left: number, top: number }} p @param {{ width: number, height: number }} size @param {{ w: number, h: number }} vp */
function edgeProblems(p, size, vp) {
  const out = [];
  if (p.left < EDGE) out.push(`left ${p.left} < ${EDGE}`);
  if (p.top < EDGE) out.push(`top ${p.top} < ${EDGE}`);
  if (p.left + size.width > vp.w - EDGE) out.push(`right ${p.left + size.width} > ${vp.w - EDGE}`);
  if (p.top + size.height > vp.h - EDGE) out.push(`bottom ${p.top + size.height} > ${vp.h - EDGE}`);
  return out;
}

/** The menu capped to the window, as mountExport does. @param {{ w: number, h: number }} vp */
const capped = (vp, w = 300, h = 170) => ({ width: Math.min(w, vp.w - 2 * EDGE), height: Math.min(h, vp.h - 2 * EDGE) });

const SIZES = [[320, 640], [375, 812], [768, 1024], [1024, 768], [1280, 800], [320, 200]];

test('the Export menu fits inside the window with an 8 px margin, wherever its button is', () => {
  for (const [w, h] of SIZES) {
    const vp = { w, h };
    const size = capped(vp);
    for (const x of [8, w / 2, w - 40]) {
      for (const y of [10, h / 2, h - 40]) {
        const btn = { left: x, top: y, bottom: y + 28, width: 30 };
        assert.deepEqual(edgeProblems(placeMenu(btn, size, vp), size, vp), [], `${w}x${h} button at ${x},${y}`);
      }
    }
  }
});

test('with room, the menu sits under its button, right-aligned to it', () => {
  const p = placeMenu({ left: 900, top: 20, bottom: 48, width: 30 }, { width: 300, height: 170 }, { w: 1280, h: 800 });
  assert.deepEqual(p, { left: 630, top: 54 });
});

test('planted fault: the old placement (right-aligned under the button, never clamped) leaves the window', () => {
  const vp = { w: 320, h: 640 };
  const btn = { left: 40, top: 220, bottom: 248, width: 30 };
  const old = { left: btn.left + btn.width - 300, top: btn.bottom + 6 };
  assert.ok(edgeProblems(old, { width: 300, height: 170 }, vp).length > 0);
  assert.deepEqual(edgeProblems(placeMenu(btn, capped(vp), vp), capped(vp), vp), []);
});

test('the embed puts the details panel below the bar when it would cover it', () => {
  assert.equal(panelBelowBar({ hostWidth: 300, barWidth: 276, panelWidth: 276, margin: 12 }), true);
  assert.equal(panelBelowBar({ hostWidth: 480, barWidth: 379, panelWidth: 300, margin: 12 }), true);
  assert.equal(panelBelowBar({ hostWidth: 1280, barWidth: 379, panelWidth: 300, margin: 12 }), false);
  // Planted fault: a rule that ignores the bar's width would keep the panel beside it at 480 px.
  const ignoresBar = (/** @type {any} */ o) => o.hostWidth - o.margin - o.panelWidth < o.margin;
  assert.equal(ignoresBar({ hostWidth: 480, barWidth: 379, panelWidth: 300, margin: 12 }), false);
});
