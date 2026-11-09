// @ts-check
// Keep a floating panel inside the window, next to the button that opens it (see ../fit.js).
import { fitPanel } from '../fit.js';

/**
 * Place `panel` now, as a fixed-position box beside `anchor`, sized to fit the window.
 * @param {HTMLElement} panel @param {HTMLElement} anchor
 * @param {{ align?: 'left'|'right' }} [o]
 */
export function fitTo(panel, anchor, o = {}) {
  if (panel.hidden) return;
  const s = panel.style;
  // Measure the panel's own size first, free of any cap from an earlier placement.
  s.position = 'fixed';
  s.right = 'auto';
  s.bottom = 'auto';
  s.width = '';
  s.maxWidth = '';
  s.maxHeight = '';
  const natural = { width: panel.offsetWidth, height: panel.offsetHeight };
  const p = fitPanel(anchor.getBoundingClientRect(), natural, { w: innerWidth, h: innerHeight }, o);
  s.boxSizing = 'border-box';
  s.width = `${Math.min(natural.width, p.maxWidth)}px`;
  s.maxHeight = `${p.maxHeight}px`;
  s.overflow = 'auto';
  s.left = `${p.left}px`;
  s.top = `${p.top}px`;
}

/**
 * Place `panel` whenever it is shown, and again on every window resize while it is.
 * @param {HTMLElement} panel @param {HTMLElement} anchor
 * @param {{ align?: 'left'|'right' }} [o]
 * @returns {() => void} call it after showing the panel
 */
export function keepFitted(panel, anchor, o = {}) {
  const place = () => fitTo(panel, anchor, o);
  addEventListener('resize', () => { if (!panel.hidden) place(); });
  return place;
}
