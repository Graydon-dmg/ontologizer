// @ts-check
// In-page dropdown logic (no DOM): keyboard handling and placement. Replaces native <select>,
// whose OS popup can open detached from the page.

/** @typedef {{ open: boolean, active: number }} DropState */

/**
 * One key press. `selected` is the index of the current value; `count` the number of options.
 * @param {DropState} s @param {string} key @param {number} count @param {number} selected
 * @returns {DropState & { pick?: number, focusButton?: boolean, handled: boolean }}
 */
export function dropdownKey(s, key, count, selected) {
  const clamp = (/** @type {number} */ i) => Math.max(0, Math.min(count - 1, i));
  if (!s.open) {
    if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
      return { open: true, active: clamp(selected < 0 ? 0 : selected), handled: true };
    }
    return { ...s, handled: false };
  }
  switch (key) {
    case 'ArrowDown': return { open: true, active: clamp(s.active + 1), handled: true };
    case 'ArrowUp': return { open: true, active: clamp(s.active - 1), handled: true };
    case 'Home': return { open: true, active: 0, handled: true };
    case 'End': return { open: true, active: count - 1, handled: true };
    case 'Enter': case ' ': return { open: false, active: s.active, pick: s.active, focusButton: true, handled: true };
    case 'Escape': return { open: false, active: s.active, focusButton: true, handled: true };
    case 'Tab': return { open: false, active: s.active, handled: false };
    default: return { ...s, handled: false };
  }
}

/**
 * Where the list goes: under the button, flipped above it near the bottom edge, and kept
 * inside the viewport.
 * @param {{ left: number, top: number, bottom: number, width: number }} btn
 * @param {{ width: number, height: number }} list
 * @param {{ w: number, h: number }} vp
 * @param {number} [gap]
 */
export function placeList(btn, list, vp, gap = 4) {
  const below = btn.bottom + gap;
  const flip = below + list.height > vp.h - 4 && btn.top - gap - list.height >= 4;
  const top = flip ? btn.top - gap - list.height : Math.max(4, Math.min(below, vp.h - 4 - list.height));
  const left = Math.max(4, Math.min(btn.left, vp.w - 4 - list.width));
  return { left: Math.round(left), top: Math.round(top), flipped: flip };
}

/**
 * Tooltip placement: under the icon, centred, inside the viewport (above it if no room below).
 * @param {{ left: number, top: number, bottom: number, width: number }} icon
 * @param {{ width: number, height: number }} tip
 * @param {{ w: number, h: number }} vp
 */
export function placeTip(icon, tip, vp) {
  const cx = icon.left + icon.width / 2;
  const left = Math.max(4, Math.min(cx - tip.width / 2, vp.w - 4 - tip.width));
  const below = icon.bottom + 6;
  const top = below + tip.height > vp.h - 4 ? icon.top - 6 - tip.height : below;
  return { left: Math.round(left), top: Math.round(Math.max(4, top)) };
}

let tipSeq = 0;
/** @type {(() => void)|null} the open tooltip's hide, so only one shows at a time */
let openTipHide = null;
/**
 * Wire an ⓘ icon to its tooltip: shown on hover AND keyboard focus, hidden on leave, blur and
 * Escape; the icon is described by the tooltip (aria-describedby); clicks on it go nowhere else.
 * Works on anything with addEventListener / setAttribute / hidden (tests pass plain EventTargets).
 * @param {any} icon @param {any} tip
 * @param {{ place?: () => void }} [o]
 */
export function bindTip(icon, tip, o = {}) {
  if (!tip.id) tip.id = `onto-tip-${++tipSeq}`;
  tip.setAttribute('role', 'tooltip');
  icon.setAttribute('tabindex', '0');
  icon.setAttribute('aria-describedby', tip.id);
  tip.hidden = true;
  const hide = () => { tip.hidden = true; if (openTipHide === hide) openTipHide = null; };
  const show = () => {
    if (openTipHide && openTipHide !== hide) openTipHide();
    openTipHide = hide;
    tip.hidden = false;
    if (o.place) o.place();
  };
  icon.addEventListener('mouseenter', show);
  icon.addEventListener('focus', show);
  icon.addEventListener('mouseleave', hide);
  icon.addEventListener('blur', hide);
  icon.addEventListener('keydown', (/** @type {any} */ e) => { if (e.key === 'Escape') hide(); });
  // The icon never triggers the control it sits next to.
  for (const t of ['click', 'mousedown', 'pointerdown']) {
    icon.addEventListener(t, (/** @type {any} */ e) => { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); });
  }
  return { show, hide };
}
