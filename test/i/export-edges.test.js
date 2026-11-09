// @ts-check
// Popovers stay inside the window (the Export menu) or the element (the embed's details panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitPanel } from '../../web/shell/fit.js';

const EDGE = 8;
/** The Export menu's placement: the shell's fitPanel, right-aligned to its button. @param {any} btn @param {{ width: number, height: number }} pop @param {{ w: number, h: number }} vp */
const placeMenu = (btn, pop, vp) => fitPanel({ ...btn, right: btn.left + btn.width }, pop, vp, { align: 'right' });
import { panelBelowBar } from '../../web/embed/helpers.js';
import { menuAnchor } from '../../web/shell/ui/export.js';

/** @param {{ left: number, top: number }} p @param {{ width: number, height: number }} size @param {{ w: number, h: number }} vp */
function edgeProblems(p, size, vp) {
  const out = [];
  if (p.left < EDGE) out.push(`left ${p.left} < ${EDGE}`);
  if (p.top < EDGE) out.push(`top ${p.top} < ${EDGE}`);
  if (p.left + size.width > vp.w - EDGE) out.push(`right ${p.left + size.width} > ${vp.w - EDGE}`);
  if (p.top + size.height > vp.h - EDGE) out.push(`bottom ${p.top + size.height} > ${vp.h - EDGE}`);
  return out;
}

/** The menu's size once capped to what fitPanel allows. @param {{ w: number, h: number }} vp */
const capped = (vp, w = 300, h = 170) => ({ width: Math.min(w, vp.w - 2 * EDGE), height: Math.min(h, vp.h - 2 * EDGE) });

const SIZES = [[320, 640], [375, 812], [768, 1024], [1024, 768], [1280, 800], [320, 200]];

test('the Export menu fits inside the window with an 8 px margin, wherever its button is', () => {
  for (const [w, h] of SIZES) {
    const vp = { w, h };
    const size = capped(vp);
    for (const x of [8, w / 2, w - 40]) {
      for (const y of [10, h / 2, h - 40]) {
        const btn = { left: x, top: y, bottom: y + 28, width: 30 };
        const p = placeMenu(btn, size, vp);
        const placed = { width: Math.min(size.width, p.maxWidth), height: Math.min(size.height, p.maxHeight) };
        assert.deepEqual(edgeProblems(p, placed, vp), [], `${w}x${h} button at ${x},${y}`);
      }
    }
  }
});

test('with room, the menu sits under its button, right-aligned to it', () => {
  const p = placeMenu({ left: 900, top: 20, bottom: 48, width: 30 }, { width: 300, height: 170 }, { w: 1280, h: 800 });
  assert.deepEqual([p.left, p.top], [630, 54]);
  // The menu really is placed this way: mountExport uses the shell's keepFitted, right-aligned.
  const src = readFileSync(new URL('../../web/shell/ui/export.js', import.meta.url), 'utf8');
  assert.match(src, /keepFitted\(pop, anchor, \{ align: 'right' \}\)/);
  assert.match(src, /menuAnchor\(btn\.getBoundingClientRect\(\)/);
});

test('planted fault: the old placement (right-aligned under the button, never clamped) leaves the window', () => {
  const vp = { w: 320, h: 640 };
  const btn = { left: 40, top: 220, bottom: 248, width: 30 };
  const old = { left: btn.left + btn.width - 300, top: btn.bottom + 6 };
  assert.ok(edgeProblems(old, { width: 300, height: 170 }, vp).length > 0);
  const p = placeMenu(btn, capped(vp), vp);
  assert.deepEqual(edgeProblems(p, capped(vp), vp), []);
});

test('the embed puts the details panel below the bar when it would cover it', () => {
  assert.equal(panelBelowBar({ hostWidth: 300, barWidth: 276, panelWidth: 276, margin: 12 }), true);
  assert.equal(panelBelowBar({ hostWidth: 480, barWidth: 379, panelWidth: 300, margin: 12 }), true);
  assert.equal(panelBelowBar({ hostWidth: 1280, barWidth: 379, panelWidth: 300, margin: 12 }), false);
  // Planted fault: a rule that ignores the bar's width would keep the panel beside it at 480 px.
  const ignoresBar = (/** @type {any} */ o) => o.hostWidth - o.margin - o.panelWidth < o.margin;
  assert.equal(ignoresBar({ hostWidth: 480, barWidth: 379, panelWidth: 300, margin: 12 }), false);
});

test('on a wrapped top bar the menu opens under the whole bar, not over the rows below its button', () => {
  // 320 px wide: the bar wraps to many rows; the Export button sits mid-bar.
  const vp = { w: 320, h: 640 };
  const btn = { left: 250, right: 280, top: 229, bottom: 257 };
  const bar = { top: 10, bottom: 326 };
  const row = { left: 8, right: 312, top: 290, bottom: 318 }; // a row of controls below the button
  const size = { width: 300, height: 163 };
  const overlaps = (/** @type {any} */ p) => !(p.left + size.width <= row.left || row.right <= p.left || p.top + size.height <= row.top || row.bottom <= p.top);
  const good = fitPanel(menuAnchor(btn, bar), size, vp, { align: 'right' });
  assert.ok(!overlaps(good), `menu at top ${good.top}`);
  assert.ok(good.top >= bar.bottom);
  // Planted fault: anchored to the button alone, the menu covers the next row of the bar.
  const buttonOnly = fitPanel(btn, size, vp, { align: 'right' });
  assert.ok(overlaps(buttonOnly));
  // A bar on one row changes nothing.
  assert.deepEqual(menuAnchor(btn, { bottom: 200 }).bottom, btn.bottom);
});
