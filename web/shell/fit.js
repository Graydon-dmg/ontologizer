// @ts-check
// Where a floating panel goes so it stays fully inside the window (no DOM here; tested in Node).
// The rule: keep an 8 px margin on every side; a panel wider than the window gets a capped width
// (and scrolls inside); one taller than the room gets a capped height (and scrolls inside).

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/**
 * @param {{ left: number, top: number, right: number, bottom: number }} anchor the button it opens from
 * @param {{ width: number, height: number }} panel the panel's natural size
 * @param {{ w: number, h: number }} vp the window
 * @param {{ margin?: number, gap?: number, align?: 'left'|'right', minHeight?: number }} [o]
 *   align: 'right' lines the panel's right edge up with the anchor's (a top-bar button on the right)
 * @returns {{ left: number, top: number, maxWidth: number, maxHeight: number }}
 */
export function fitPanel(anchor, panel, vp, { margin = 8, gap = 6, align = 'right', minHeight = 160 } = {}) {
  const maxWidth = Math.max(0, vp.w - 2 * margin);
  const width = Math.min(panel.width, maxWidth);
  const left = clamp(align === 'right' ? anchor.right - width : anchor.left, margin, Math.max(margin, vp.w - margin - width));

  const below = vp.h - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  const want = Math.min(panel.height, vp.h - 2 * margin);
  let top;
  let maxHeight;
  if (want <= below || (below >= above && below >= Math.min(want, minHeight))) {
    top = anchor.bottom + gap;
    maxHeight = below;
  } else if (above >= Math.min(want, minHeight)) {
    maxHeight = above;
    top = anchor.top - gap - Math.min(want, above);
  } else {
    // No room on either side (a tall wrapped top bar on a short window): over the anchor, full height.
    maxHeight = vp.h - 2 * margin;
    top = vp.h - margin - want;
  }
  maxHeight = Math.max(0, maxHeight);
  top = clamp(top, margin, Math.max(margin, vp.h - margin - Math.min(want, maxHeight)));
  return { left: Math.round(left), top: Math.round(top), maxWidth: Math.floor(maxWidth), maxHeight: Math.floor(maxHeight) };
}

/**
 * Problems with a placed box: any edge outside the window (less the margin). Used by the tests.
 * @param {{ left: number, top: number, width: number, height: number }} box
 * @param {{ w: number, h: number }} vp @param {number} [margin]
 * @returns {string[]}
 */
export function outside(box, vp, margin = 0) {
  const problems = [];
  if (box.left < margin) problems.push(`left ${box.left} < ${margin}`);
  if (box.top < margin) problems.push(`top ${box.top} < ${margin}`);
  if (box.left + box.width > vp.w - margin) problems.push(`right ${box.left + box.width} > ${vp.w - margin}`);
  if (box.top + box.height > vp.h - margin) problems.push(`bottom ${box.top + box.height} > ${vp.h - margin}`);
  return problems;
}
