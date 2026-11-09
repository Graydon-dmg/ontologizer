// @ts-check
// "New map" from a map page: the home opens the dialog on ?new=1 and drops it from the URL; the brand
// menu's keyboard rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMapRequested } from '../../web/home/flow.js';
import { menuStep } from '../../web/shell/brand-menu.js';

/** @param {typeof newMapRequested} handle @returns {string[]} */
function newParamProblems(handle) {
  const problems = [];
  const want = /** @type {Array<[string, boolean, string]>} */ ([
    ['?new=1', true, ''],
    ['?new=1&next=%2Fv1%2Ft%2Fdefault%2Fmaps%2Fdemo%2Fview', true, '?next=%2Fv1%2Ft%2Fdefault%2Fmaps%2Fdemo%2Fview'],
    ['?x=2&new=1', true, '?x=2'],
    ['', false, ''],
    ['?new=0', false, ''],
    ['?new=yes', false, ''],
    ['?x=2', false, '?x=2'],
  ]);
  for (const [search, open, rest] of want) {
    const r = handle(search);
    if (r.open !== open) problems.push(`${search || '(none)'}: open ${r.open}`);
    if (r.search !== rest) problems.push(`${search || '(none)'}: left "${r.search}" in the URL`);
  }
  return problems;
}

test('the home opens New map on ?new=1, and removes it from the URL (other parameters stay)', () => {
  assert.deepEqual(newParamProblems(newMapRequested), []);
  // Planted faults: a home that ignores new=1, and one that opens but leaves it in the URL.
  const ignores = (/** @type {string} */ s) => ({ open: false, search: s });
  assert.ok(newParamProblems(ignores).some((p) => p.startsWith('?new=1: open false')));
  const keeps = (/** @type {string} */ s) => ({ open: new URLSearchParams(s).get('new') === '1', search: s });
  assert.ok(newParamProblems(keeps).some((p) => p.includes('left "?new=1"')));
});

/** @param {typeof menuStep} step */
function keyProblems(step) {
  const problems = [];
  const expect = (/** @type {any} */ got, /** @type {any} */ want, /** @type {string} */ what) => {
    for (const k of Object.keys(want)) if (got[k] !== want[k]) problems.push(`${what}: ${k} ${got[k]}`);
  };
  expect(step(0, 'ArrowDown', 2), { handled: true, focus: 1 }, 'down');
  expect(step(1, 'ArrowDown', 2), { focus: 0 }, 'down wraps');
  expect(step(0, 'ArrowUp', 2), { focus: 1 }, 'up wraps');
  expect(step(-1, 'ArrowDown', 2), { focus: 0 }, 'down from nothing');
  expect(step(1, 'Home', 2), { focus: 0 }, 'home');
  expect(step(0, 'End', 2), { focus: 1 }, 'end');
  expect(step(0, 'Escape', 2), { handled: true, close: true, toButton: true }, 'escape');
  expect(step(0, 'Tab', 2), { handled: false, close: true, toButton: false }, 'tab');
  expect(step(0, 'Enter', 2), { handled: false }, 'enter is the link\'s own');
  return problems;
}

test('brand menu keys: arrows move and wrap, Home/End, Escape back to the button, Tab closes', () => {
  assert.deepEqual(keyProblems(menuStep), []);
  // Planted fault: a menu whose Escape does nothing.
  const noEscape = (/** @type {number} */ i, /** @type {string} */ k, /** @type {number} */ n) => (k === 'Escape' ? { handled: false } : menuStep(i, k, n));
  assert.ok(keyProblems(noEscape).some((p) => p.startsWith('escape')));
});
