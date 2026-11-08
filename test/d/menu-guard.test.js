// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuGuard, MENU_ARM_MS } from '../../web/shell/menu.js';

// Replays a gesture against a guard and returns which item clicks were allowed.
// Steps: ['open', t] | ['downInside', t] | ['click', t] | ['key', t]
/** @param {ReturnType<typeof createMenuGuard>} guard @param {[string, number][]} steps */
function run(guard, steps) {
  /** @type {boolean[]} */
  const fired = [];
  for (const [s, t] of steps) {
    if (s === 'open') guard.opened(t);
    else if (s === 'downInside') guard.pointerDownInside(t);
    else fired.push(guard.allow(t, s === 'key'));
  }
  return fired;
}

/** @param {() => ReturnType<typeof createMenuGuard>} make */
function checkGuard(make) {
  // The click that opened the menu (no press inside it) must not trigger an item.
  assert.deepEqual(run(make(), [['open', 1000], ['click', 1005]]), [false]);
  // The second click of a double-click, still in the same gesture.
  assert.deepEqual(run(make(), [['open', 1000], ['click', 1180]]), [false]);
  // Even late, a click whose press did not start inside the menu (ends a drag) is ignored.
  assert.deepEqual(run(make(), [['open', 1000], ['click', 1600]]), [false]);
  // A real pick: press inside the menu after it opened, then click.
  assert.deepEqual(run(make(), [['open', 1000], ['downInside', 1500], ['click', 1560]]), [true]);
  // Keyboard (Enter/Space on a focused item) after the arm time works; too soon does not.
  assert.deepEqual(run(make(), [['open', 1000], ['key', 1000 + MENU_ARM_MS + 1]]), [true]);
  assert.deepEqual(run(make(), [['open', 1000], ['key', 1050]]), [false]);
  // Reopening resets the press-inside state.
  assert.deepEqual(run(make(), [['open', 1000], ['downInside', 1500], ['open', 2000], ['click', 2400]]), [false]);
}

test('a click that opened the menu never triggers an item; only a press inside the open menu does', () => {
  checkGuard(createMenuGuard);
});

test('planted fault: a menu that activates on any click is caught', () => {
  const naive = () => ({ opened() {}, pointerDownInside() {}, allow: () => true });
  assert.throws(() => checkGuard(/** @type {any} */ (naive)));
});

test('planted fault: a time-only guard (no press-inside check) is caught', () => {
  const timeOnly = () => {
    let at = -Infinity;
    return { opened: (/** @type {number} */ t) => { at = t; }, pointerDownInside() {}, allow: (/** @type {number} */ t) => t - at >= MENU_ARM_MS };
  };
  assert.throws(() => checkGuard(/** @type {any} */ (timeOnly)));
});
