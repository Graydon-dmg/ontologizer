// @ts-check
// Keyboard rules for the brand menu (no DOM; tested in Node). Arrows move and wrap, Home/End jump,
// Escape closes back to the button, Tab closes and lets focus move on; Enter and Space on an item
// are the link's own activation, so they are not handled here.

/**
 * @param {number} index the focused item (-1: none) @param {string} key @param {number} n items
 * @returns {{ handled: boolean, focus?: number, close?: boolean, toButton?: boolean }}
 */
export function menuStep(index, key, n) {
  if (n <= 0) return { handled: false };
  switch (key) {
    case 'ArrowDown': return { handled: true, focus: index < 0 ? 0 : (index + 1) % n };
    case 'ArrowUp': return { handled: true, focus: index < 0 ? n - 1 : (index - 1 + n) % n };
    case 'Home': return { handled: true, focus: 0 };
    case 'End': return { handled: true, focus: n - 1 };
    case 'Escape': return { handled: true, close: true, toButton: true };
    case 'Tab': return { handled: false, close: true, toButton: false };
    default: return { handled: false };
  }
}
