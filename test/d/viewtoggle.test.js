// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleButtons, pressToggle, shortLabel } from '../../web/shell/viewtoggle.js';
import { viewStateToApply, applyViewState } from '../../web/shell/viewstate.js';

const VIEWS = [
  { id: 'graph-2d', label: '2D graph', elementName: 'onto-graph' },
  { id: 'sky-3d', label: 'Floor and Sky', elementName: 'onto-sky' },
];

// A fake view element that records what the shell applies to it.
function fakeView(/** @type {string} */ id) {
  /** @type {any} */
  const v = { id, focus: null, filter: null, lens: undefined };
  v.setFocus = (/** @type {any} */ x) => { v.focus = x; };
  v.setFilter = (/** @type {any} */ x) => { v.filter = x; };
  v.setLens = (/** @type {any} */ x) => { v.lens = x; };
  return v;
}

// A shell that switches the way main.js does: mount the new view, re-apply the view state.
function fakeShell() {
  const view = { collapsed: [], focus: 'pm/tools', layout: 'graph-2d', lens: 'cook',
                 filter: { categories: ['pm/tools'], maxDepth: 2 } };
  /** @type {any[]} */
  const acts = [];
  const shell = {
    views: VIEWS,
    active: fakeView('graph-2d'),
    activeViewId() { return this.active.id; },
    switchView(/** @type {string} */ id) {
      this.active = fakeView(id);
      applyViewState(this.active, viewStateToApply(view));
      acts.push({ type: 'layout', value: id });
    },
  };
  return { shell, acts };
}

/** @param {(shell: any, id: string) => any} press */
function checkToggle(press) {
  const { shell, acts } = fakeShell();
  const b = toggleButtons(shell.views, shell.activeViewId());
  assert.deepEqual(b.map((x) => [x.label, x.pressed]), [['2D', true], ['3D', false]]);
  press(shell, '3D' === b[1].label ? b[1].id : '');
  assert.equal(shell.activeViewId(), 'sky-3d');
  assert.deepEqual(acts, [{ type: 'layout', value: 'sky-3d' }]);
  // Switching keeps focus, filter and lens (the same check as viewstate.test.js).
  assert.equal(shell.active.focus, 'pm/tools');
  assert.deepEqual(shell.active.filter, { categories: ['pm/tools'], maxDepth: 2 });
  assert.equal(shell.active.lens, 'cook');
  const after = toggleButtons(shell.views, shell.activeViewId());
  assert.deepEqual(after.map((x) => x.pressed), [false, true]);
}

test('the 2D | 3D toggle switches the view through shell.switchView and keeps focus and filter', () => {
  checkToggle(pressToggle);
});

test('planted fault: a toggle that does not call switchView is caught', () => {
  const bad = (/** @type {any} */ shell, /** @type {string} */ id) => { shell.activeId = id; };
  assert.throws(() => checkToggle(bad));
});

test('pressing the active view does nothing; one registered view shows no toggle', () => {
  const { shell, acts } = fakeShell();
  assert.equal(pressToggle(shell, 'graph-2d'), false);
  assert.deepEqual(acts, []);
  assert.deepEqual(toggleButtons([VIEWS[0]], 'graph-2d'), []);
  assert.deepEqual(toggleButtons([], null), []);
});

test('labels are short: 2D for graph-2d, 3D for the sky view, a short label kept as is', () => {
  assert.equal(shortLabel({ id: 'graph-2d', label: '2D graph' }), '2D');
  assert.equal(shortLabel({ id: 'sky', label: 'Floor and Sky' }), '3D');
  assert.equal(shortLabel({ id: 'sky-3d', label: '3D sky view' }), '3D');
  assert.equal(shortLabel({ id: 'x', label: 'XR' }), 'XR');
});
