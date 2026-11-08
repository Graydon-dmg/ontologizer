// @ts-check
import { bindTip, placeTip } from '../dropdown.js';

/**
 * A small ⓘ icon with a one-line tooltip (hover or keyboard focus).
 * @param {string} text  at most ~90 characters
 * @param {string} [name] what it explains, for screen readers ("About Depth")
 * @returns {HTMLElement}
 */
export function infoTip(text, name = '') {
  const icon = document.createElement('span');
  icon.className = 'info';
  icon.textContent = 'ⓘ';
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', name ? `About ${name}` : 'About this control');
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.textContent = text;
  document.body.append(tip);
  bindTip(icon, tip, {
    place: () => {
      const p = placeTip(icon.getBoundingClientRect(), { width: tip.offsetWidth, height: tip.offsetHeight }, { w: innerWidth, h: innerHeight });
      tip.style.left = p.left + 'px';
      tip.style.top = p.top + 'px';
    },
  });
  return icon;
}
