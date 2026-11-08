import test from 'node:test';
import assert from 'node:assert/strict';
import { viewStateToApply, applyViewState } from '../../web/shell/viewstate.js';

const view = { focus: 'a', filter: { categories: ['x'], maxDepth: 2 }, lens: 'cook', collapsed: [], layout: 'graph-2d' };

// Planted fault: a view switch that resets the state.
const resettingViewState = () => ({ focus: '', filter: { categories: null, maxDepth: null }, lens: null });

function checkKeepsState(fn) {
  const s = fn(view);
  assert.equal(s.focus, 'a');
  assert.deepEqual(s.filter, { categories: ['x'], maxDepth: 2 });
  assert.equal(s.lens, 'cook');
}

test('Switching views keeps focus, filter and lens', () => {
  checkKeepsState(viewStateToApply);
  assert.throws(() => checkKeepsState(resettingViewState), assert.AssertionError);
});

test('viewStateToApply copies and keeps null lens', () => {
  const s = viewStateToApply({ ...view, lens: null });
  assert.equal(s.lens, null);
  s.filter.categories.push('y');
  assert.deepEqual(view.filter.categories, ['x']);
});

test('applyViewState calls setFocus, setFilter and setLens(null)', () => {
  const calls = [];
  const el = {
    setFocus: (v) => calls.push(['focus', v]),
    setFilter: (v) => calls.push(['filter', v]),
    setLens: (v) => calls.push(['lens', v]),
  };
  applyViewState(el, viewStateToApply({ ...view, lens: null }));
  assert.deepEqual(calls, [['focus', 'a'], ['filter', { categories: ['x'], maxDepth: 2 }], ['lens', null]]);
  applyViewState({}, viewStateToApply(view)); // missing methods are skipped
  const c2 = [];
  applyViewState({ setFocus: (v) => c2.push(v) }, viewStateToApply({ ...view, focus: '' }));
  assert.deepEqual(c2, []);
});
