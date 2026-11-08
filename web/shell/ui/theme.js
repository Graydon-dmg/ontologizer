// @ts-check
import { THEME_CHOICES, loadChoice, saveChoice, applyTheme } from '../theme.js';

const LABELS = { system: 'System', light: 'Light', dark: 'Dark' };

/** Three-way System / Light / Dark toggle. @param {HTMLElement} el @param {any} shell */
export function mountTheme(el, shell) {
  /** @type {Storage|null} */
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  const mq = matchMedia('(prefers-color-scheme: light)');
  let choice = loadChoice(storage);
  const group = document.createElement('div');
  group.className = 'seg theme-toggle';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Theme');
  const apply = () => {
    applyTheme(document, choice, mq.matches, shell.tokens, (t, init) => new CustomEvent(t, init));
    for (const b of group.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.choice === choice));
    }
  };
  for (const c of THEME_CHOICES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.choice = c;
    b.textContent = LABELS[c];
    b.addEventListener('click', () => { choice = c; saveChoice(storage, c); apply(); });
    group.append(b);
  }
  el.replaceChildren(group);
  mq.addEventListener('change', () => { if (choice === 'system') apply(); });
  apply();
}
