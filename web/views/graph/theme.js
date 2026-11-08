// @ts-check
// The view's palette follows the page: the shell's System / Light / Dark toggle sets
// document.documentElement.dataset.theme ('light' | 'dark') and dispatches `onto-theme` on
// document; when the attribute is absent ("System"), prefers-color-scheme decides.
import { THEME } from '../../shared/tokens.js';

/** @returns {'light'|'dark'} */
export function themeName() {
  const set = globalThis.document?.documentElement?.dataset?.theme;
  if (set === 'light' || set === 'dark') return set;
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** @returns {typeof THEME.dark} */
export function th() {
  return THEME[themeName()];
}

/**
 * Set the CSS variables the view's elements paint with (--o-fg, --o-bg, --o-muted, --o-panel).
 * @param {any} sel a d3 selection of an <svg>
 */
export function themeVars(sel) {
  const t = th();
  sel.style('--o-fg', t.fg).style('--o-bg', t.bg).style('--o-muted', t.muted).style('--o-panel', t.panel);
}

/**
 * Call fn when the theme may have changed (toggle event or system setting).
 * @param {() => void} fn
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(fn) {
  const doc = globalThis.document;
  const mq = globalThis.matchMedia?.('(prefers-color-scheme: light)');
  doc?.addEventListener('onto-theme', fn);
  mq?.addEventListener?.('change', fn);
  return () => {
    doc?.removeEventListener('onto-theme', fn);
    mq?.removeEventListener?.('change', fn);
  };
}
