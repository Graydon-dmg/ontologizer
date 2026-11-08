// @ts-check
// Light / dark / system theme (no DOM). Colors come from tokens.THEME only.

export const THEME_CHOICES = /** @type {const} */ (['system', 'light', 'dark']);
export const THEME_KEY = 'ontologizer.theme';

/** @param {any} c @returns {'system'|'light'|'dark'} */
export function normalizeChoice(c) {
  return c === 'light' || c === 'dark' ? c : 'system';
}

/**
 * The theme actually shown.
 * @param {'system'|'light'|'dark'} choice @param {boolean} prefersLight
 * @returns {'light'|'dark'}
 */
export function resolveTheme(choice, prefersLight) {
  if (choice === 'light' || choice === 'dark') return choice;
  return prefersLight ? 'light' : 'dark';
}

/** @param {{ getItem: (k: string) => string|null }|null|undefined} storage */
export function loadChoice(storage) {
  try { return normalizeChoice(storage ? storage.getItem(THEME_KEY) : null); } catch { return 'system'; }
}

/** @param {{ setItem: (k: string, v: string) => void }|null|undefined} storage @param {string} choice */
export function saveChoice(storage, choice) {
  try { if (storage) storage.setItem(THEME_KEY, normalizeChoice(choice)); } catch { /* private mode */ }
}

/**
 * Apply a choice to the document: data-theme ('light'|'dark', removed for System), the CSS
 * variables from tokens.THEME, and the 'onto-theme' event that views listen for.
 * @param {{ documentElement: any, dispatchEvent: (e: any) => any }} doc
 * @param {'system'|'light'|'dark'} choice
 * @param {boolean} prefersLight
 * @param {{ THEME: Record<string, Record<string, string>> }} tokens
 * @param {(type: string, init: any) => any} makeEvent
 */
export function applyTheme(doc, choice, prefersLight, tokens, makeEvent) {
  const theme = resolveTheme(choice, prefersLight);
  const root = doc.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  const th = tokens.THEME[theme];
  for (const k of Object.keys(th)) root.style.setProperty('--' + k, th[k]);
  root.style.colorScheme = theme;
  doc.dispatchEvent(makeEvent('onto-theme', { detail: { theme, choice } }));
  return theme;
}
