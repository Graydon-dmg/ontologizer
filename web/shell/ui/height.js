// @ts-check
import { HEIGHT_OPTIONS, loadHeight, saveHeight, normalizeHeight, hasHeight } from '../height.js';
import { createDropdown } from './dropdown.js';

/**
 * The 3D view's "Height" dropdown: Off, Learning order, Coverage, Connectedness. Shown only while
 * the active view draws height (implements setHeight); the choice is remembered in this browser.
 * Emits 'height' on the shell bus when it changes, and exposes shell.heightMode().
 * @param {HTMLElement} el @param {any} shell
 */
export function mountHeight(el, shell) {
  /** @type {Storage|null} */
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  let mode = loadHeight(storage);
  el.classList.add('height-switcher');
  const label = document.createElement('span');
  label.className = 'dd-label height-label';
  // The tightest top-bar band (1280-1366 px) shows a compact mark instead of the word (shell.css).
  const word = document.createElement('span');
  word.className = 'height-word';
  word.textContent = 'Height';
  const mark = document.createElement('span');
  mark.className = 'height-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '↕';
  label.title = 'Height';
  label.append(word, mark);
  const dd = createDropdown({
    ariaLabel: 'Height in 3D',
    options: HEIGHT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    value: mode,
    onSelect: (v) => {
      mode = normalizeHeight(v);
      dd.setValue(mode);
      saveHeight(storage, mode);
      push();
      shell.emit('height', { mode });
    },
  });
  dd.el.classList.add('height-dd');
  el.append(label, dd.el);
  shell.heightMode = () => mode;

  const push = () => {
    const v = shell.activeView();
    if (hasHeight(v)) { try { v.setHeight(mode); } catch (err) { console.error('[shell] setHeight failed', err); } }
  };
  const sync = () => {
    el.hidden = !hasHeight(shell.activeView());
    push();
  };
  shell.on('view', sync);
  sync();
}
