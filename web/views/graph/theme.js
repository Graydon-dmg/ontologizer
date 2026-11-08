// @ts-check
// The view's palette follows the same rule as the shell (web/shell/main.js): light when the
// system prefers light, dark otherwise.
import { THEME } from '../../shared/tokens.js';

/** @returns {typeof THEME.dark} */
export function th() {
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? THEME.light : THEME.dark;
}
