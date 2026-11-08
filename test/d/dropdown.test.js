// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { dropdownKey, placeList, placeTip, bindTip } from '../../web/shell/dropdown.js';
import { lensMenuOptions, pickLens, chooseLens, NEW_LENS } from '../../web/shell/lens.js';
import { DEPTH_OPTIONS, filterValue, sendFilter } from '../../web/shell/filter.js';

/** Drive the dropdown with keys; returns the picked option's value (or null) and the final state. */
function press(/** @type {typeof dropdownKey} */ key, /** @type {string[]} */ keys, /** @type {{ value: string }[]} */ opts, /** @type {string} */ value) {
  let s = { open: false, active: 0 };
  /** @type {string|null} */ let picked = null;
  let focusButton = false;
  for (const k of keys) {
    const r = key(s, k, opts.length, opts.findIndex((o) => o.value === value));
    s = { open: r.open, active: r.active };
    if (r.pick !== undefined) picked = opts[r.pick].value;
    if (r.focusButton) focusButton = true;
  }
  return { picked, open: s.open, focusButton };
}

const ev = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const onto = foldAll([...ev,
  { t: 'lens.added', at: 1, lens: { id: 'cook', persona: 'a home chef', analogs: {} } }]);

/** @param {typeof dropdownKey} key */
function checkKeys(key) {
  // Depth: Enter opens on "Any", ArrowDown twice, Enter picks "2".
  assert.deepEqual(press(key, ['Enter', 'ArrowDown', 'ArrowDown', 'Enter'], DEPTH_OPTIONS, ''), { picked: '2', open: false, focusButton: true });
  // Space and ArrowDown open too; Escape closes without picking and returns focus to the button.
  assert.deepEqual(press(key, [' ', 'ArrowDown', 'Escape'], DEPTH_OPTIONS, ''), { picked: null, open: false, focusButton: true });
  assert.deepEqual(press(key, ['ArrowDown'], DEPTH_OPTIONS, '3'), { picked: null, open: true, focusButton: false });
  // Arrows clamp at the ends.
  assert.equal(press(key, ['Enter', 'ArrowUp', 'ArrowUp', 'Enter'], DEPTH_OPTIONS, '').picked, '');
}

test('dropdown keys: Enter/Space/ArrowDown open, arrows move, Enter selects, Esc closes and returns focus', () => {
  checkKeys(dropdownKey);
});

test('planted fault: a dropdown that ignores Escape is caught', () => {
  const noEsc = /** @type {typeof dropdownKey} */ ((s, k, n, sel) => (k === 'Escape' ? { ...s, handled: false } : dropdownKey(s, k, n, sel)));
  assert.throws(() => checkKeys(noEsc));
});

/** Picking through the Rosetta and Depth dropdowns fires the same actions the <select>s did. */
function checkActions(/** @type {typeof pickLens} */ pick, /** @type {typeof sendFilter} */ send) {
  /** @type {any[]} */ const acts = [];
  /** @type {any[]} */ const lensCalls = [];
  let popover = 0;
  const view = { setLens: (/** @type {any} */ x) => lensCalls.push(x), setFilter: () => {} };
  const opts = lensMenuOptions(onto);
  assert.deepEqual(opts.map((o) => o.label), ['None', 'a home chef', 'New lens…']);
  const on = { choose: (/** @type {string} */ v) => chooseLens(view, (a) => acts.push(a), v), openNew: () => { popover++; } };
  pick(/** @type {string} */ (press(dropdownKey, ['Enter', 'ArrowDown', 'Enter'], opts, 'none').picked), on);
  pick(/** @type {string} */ (press(dropdownKey, ['Enter', 'ArrowUp', 'Enter'], opts, 'cook').picked), on);
  pick(/** @type {string} */ (press(dropdownKey, ['Enter', 'End', 'Enter'], opts, 'none').picked), on);
  assert.deepEqual(acts, [{ type: 'lens', value: 'cook' }, { type: 'lens', value: null }]);
  assert.deepEqual(lensCalls, ['cook', null]);
  assert.equal(popover, 1, '"New lens…" opens the popover and sends nothing');
  // Depth: picking "1" sends exactly what the old <select> sent.
  const shell = { activeView: () => view, act: (/** @type {any} */ a) => { acts.push(a); } };
  const d = press(dropdownKey, ['ArrowDown', 'ArrowDown', 'Enter'], DEPTH_OPTIONS, '').picked;
  send(shell, filterValue(['a', 'b'], ['a', 'b'], /** @type {string} */ (d)));
  assert.deepEqual(acts.at(-1), { type: 'filter', value: { categories: null, maxDepth: 1 } });
}

test('the dropdowns select and fire the same actions as before (lens, New lens…, depth filter)', () => {
  checkActions(pickLens, sendFilter);
});

test('planted fault: a Rosetta pick that never sends the lens action is caught', () => {
  const viewOnly = /** @type {typeof pickLens} */ ((v, on) => { if (v !== NEW_LENS) void on; else on.openNew(); });
  assert.throws(() => checkActions(viewOnly, sendFilter));
});

test('planted fault: a Depth pick that only redraws (no filter action) is caught', () => {
  const noAct = /** @type {typeof sendFilter} */ ((shell, value) => { shell.activeView().setFilter(value); });
  assert.throws(() => checkActions(pickLens, noAct));
});

test('the list opens under the button, flips up near the bottom, and stays inside the viewport', () => {
  const vp = { w: 900, h: 700 };
  assert.deepEqual(placeList({ left: 100, top: 20, bottom: 44, width: 80 }, { width: 120, height: 150 }, vp), { left: 100, top: 48, flipped: false });
  assert.equal(placeList({ left: 100, top: 640, bottom: 664, width: 80 }, { width: 120, height: 150 }, vp).flipped, true);
  assert.equal(placeList({ left: 860, top: 20, bottom: 44, width: 30 }, { width: 120, height: 150 }, vp).left, 776);
  const t = placeTip({ left: 890, top: 10, bottom: 26, width: 16 }, { width: 300, height: 22 }, vp);
  assert.ok(t.left + 300 <= 896 && t.left >= 4);
});

class FakeEl extends EventTarget {
  constructor() { super(); this.hidden = false; /** @type {Record<string, string>} */ this.attrs = {}; this.id = ''; }
  /** @param {string} k @param {string} v */ setAttribute(k, v) { this.attrs[k] = v; }
}

/** @param {typeof bindTip} bind */
function checkTip(bind) {
  const icon = new FakeEl(), tip = new FakeEl();
  bind(icon, tip, {});
  assert.equal(tip.hidden, true);
  assert.equal(icon.attrs.tabindex, '0', 'keyboard-focusable');
  assert.equal(icon.attrs['aria-describedby'], tip.id);
  assert.equal(tip.attrs.role, 'tooltip');
  icon.dispatchEvent(new Event('focus'));
  assert.equal(tip.hidden, false, 'shows on keyboard focus');
  icon.dispatchEvent(new Event('blur'));
  assert.equal(tip.hidden, true);
  icon.dispatchEvent(new Event('mouseenter'));
  assert.equal(tip.hidden, false, 'shows on hover');
  const click = new Event('click', { cancelable: true });
  icon.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'a click on ⓘ does not reach the control');
}

test('the ⓘ tooltip appears on keyboard focus and on hover, is described-by, and swallows its own clicks', () => {
  checkTip(bindTip);
});

test('planted fault: a tooltip that only shows on mouse hover (not on focus) is caught', () => {
  const hoverOnly = /** @type {typeof bindTip} */ ((icon, tip) => {
    tip.id = 'x'; tip.setAttribute('role', 'tooltip'); icon.setAttribute('tabindex', '0'); icon.setAttribute('aria-describedby', 'x'); tip.hidden = true;
    icon.addEventListener('mouseenter', () => { tip.hidden = false; });
    return { show() {}, hide() {} };
  });
  assert.throws(() => checkTip(hoverOnly));
});

test('only one tooltip shows at a time', () => {
  const a = new FakeEl(), ta = new FakeEl(), b2 = new FakeEl(), tb = new FakeEl();
  bindTip(a, ta, {}); bindTip(b2, tb, {});
  a.dispatchEvent(new Event('mouseenter'));
  b2.dispatchEvent(new Event('focus'));
  assert.deepEqual([ta.hidden, tb.hidden], [true, false]);
});
