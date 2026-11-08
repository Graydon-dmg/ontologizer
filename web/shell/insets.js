// @ts-check
// Space the shell's floating panels take from the view, as four insets (no DOM).
// The shell writes them on the view mount element as --onto-inset-top/right/bottom/left and
// dispatches 'onto-insets' there, so views can fit their drawing inside the free area.

/** @typedef {{ top: number, right: number, bottom: number, left: number }} Insets */
/** @typedef {{ left: number, top: number, right: number, bottom: number }} Rect */

export const INSET_GAP = 8;
const EDGE = 24; // a panel within this many px of an edge counts as anchored to it

/**
 * Each panel is charged to the side (of those it touches) that costs the least view area,
 * given what the other panels already take: a tall legend becomes a left inset, a collapsed
 * legend (just its header) only pushes the top down.
 * @param {{ w: number, h: number }} vp
 * @param {Rect[]} rects  visible panels, in viewport coordinates
 * @param {number} [gap]
 * @returns {Insets}
 */
export function computeInsets(vp, rects, gap = INSET_GAP) {
  /** @type {Insets} */
  const ins = { top: 0, right: 0, bottom: 0, left: 0 };
  // Biggest panels first, so small ones can ride on space already given up.
  const sorted = rects
    .filter((r) => r && r.right - r.left > 0 && r.bottom - r.top > 0)
    .sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top));
  for (const r of sorted) {
    /** @type {[keyof Insets, number][]} */
    const options = [];
    // A panel touches a side when it sits against the window edge or against what is already taken
    // there (a legend just under the top bar touches the top).
    if (r.top <= ins.top + EDGE) options.push(['top', r.bottom + gap]);
    if (r.left <= ins.left + EDGE) options.push(['left', r.right + gap]);
    if (vp.w - r.right <= ins.right + EDGE) options.push(['right', vp.w - r.left + gap]);
    if (vp.h - r.bottom <= ins.bottom + EDGE) options.push(['bottom', vp.h - r.top + gap]);
    if (!options.length) continue;
    let best = options[0];
    let bestCost = Infinity;
    for (const o of options) {
      const next = { ...ins, [o[0]]: Math.max(ins[o[0]], o[1]) };
      const cost = vp.w * vp.h - Math.max(0, vp.w - next.left - next.right) * Math.max(0, vp.h - next.top - next.bottom);
      if (cost < bestCost) { bestCost = cost; best = o; }
    }
    ins[best[0]] = Math.max(ins[best[0]], best[1]);
  }
  for (const k of /** @type {(keyof Insets)[]} */ (['top', 'right', 'bottom', 'left'])) ins[k] = Math.ceil(ins[k]);
  return ins;
}

/** @param {Insets|null} a @param {Insets} b */
export function sameInsets(a, b) {
  return !!a && a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Height reserved for the one-line ticker at the bottom (px), and its share of the width. */
export const TICKER_STRIP = { height: 40, widthShare: 0.4, margin: 10 };

/**
 * The fixed strip the ticker may occupy: bottom left, one line, up to 40% of the width.
 * @param {number} w @param {number} h
 * @returns {Rect}
 */
export function tickerStrip(w, h) {
  const { height, widthShare, margin } = TICKER_STRIP;
  return { left: margin, top: h - margin - height + 10, right: margin + Math.round(w * widthShare), bottom: h - margin };
}
