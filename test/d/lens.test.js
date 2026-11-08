// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldAll } from '../../src/core/events.js';
import { lensOptions, lensSelection, chooseLens, analogFor } from '../../web/shell/lens.js';

const base = { t: 'ontology.created', at: 0, name: 'x', root: 'x', brief: {}, categories: [] };
const node = { id: 'x/a', label: 'A', parent: 'x', category: '', depth: 1, origin: 'seed', sources: [], article: null, status: 'done', createdBy: 'w' };
const lens = { id: 'cook', persona: 'Chef', analogs: {} };
const events = [
  base,
  { t: 'node.added', at: 1, node },
  { t: 'lens.added', at: 2, lens },
  { t: 'lens.analog', at: 3, lensId: 'cook', nodeId: 'x/a', label: 'Knife', breaks: 'no edge' },
  { t: 'view.changed', at: 4, patch: { lens: 'cook' } },
];

function drive(/** @type {typeof chooseLens} */ choose) {
  const calls = [];
  const acts = [];
  const view = { setLens: (/** @type {any} */ v) => calls.push(v) };
  choose(view, (a) => acts.push(a), 'cook');
  choose(view, (a) => acts.push(a), 'none');
  assert.deepEqual(calls, ['cook', null]);
  assert.deepEqual(acts, [{ type: 'lens', value: 'cook' }, { type: 'lens', value: null }]);
}

/** Planted fault: never calls setLens(null). */
function brokenChoose(/** @type {any} */ view, /** @type {any} */ act, /** @type {any} */ value) {
  const s = lensSelection(value);
  if (s.setLensArg !== null) view?.setLens?.(s.setLensArg);
  return act(s.action);
}

test('With a lens active and then set back to none, the shell calls setLens(null), clearing every ghost label', () => {
  assert.doesNotThrow(() => drive(chooseLens));
  assert.throws(() => drive(brokenChoose));
});

test('lensSelection normalizes none', () => {
  for (const v of ['', 'none', undefined, null]) assert.deepEqual(lensSelection(v), { action: { type: 'lens', value: null }, setLensArg: null });
});

test('lensOptions lists none plus every lens', () => {
  assert.deepEqual(lensOptions(foldAll(events.slice(0, 2))), [{ value: null, label: 'none' }]);
  assert.deepEqual(lensOptions(foldAll(events)), [{ value: null, label: 'none' }, { value: 'cook', label: 'Chef' }]);
});

test('analogFor returns label and breaks with lens active, null after lens cleared', () => {
  const on = foldAll(events);
  assert.deepEqual(analogFor(on, 'x/a'), { lensId: 'cook', persona: 'Chef', label: 'Knife', breaks: 'no edge' });
  assert.equal(analogFor(on, 'x/zzz'), null);
  const off = foldAll([...events, { t: 'view.changed', at: 5, patch: { lens: null } }]);
  assert.equal(analogFor(off, 'x/a'), null);
});
