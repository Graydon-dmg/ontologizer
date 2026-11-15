// @ts-check
// S: parseInclude is final in S and accepts every documented form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInclude, withHydration, snapshotFor } from '../../src/core/export/hydration.js';

test('parseInclude accepts every listed form', () => {
  assert.deepEqual(parseInclude(undefined), []);
  assert.deepEqual(parseInclude(''), []);
  assert.deepEqual(parseInclude('hydration'), ['hydration']);
  assert.deepEqual(parseInclude('hydration,hydration'), ['hydration']);
  assert.deepEqual(parseInclude('["hydration"]'), ['hydration']);
  assert.deepEqual(parseInclude(['hydration', 'hydration']), ['hydration']);
  assert.deepEqual(parseInclude([]), []);
});

test('parseInclude throws 400 on an unknown value', () => {
  for (const bad of ['hydrations', 'hydration,x', '["nope"]', ['hydration', 'x']]) {
    assert.throws(() => parseInclude(bad), (/** @type {any} */ e) => e.status === 400 && /unknown include "/.test(e.message), String(bad));
  }
  // planted fault: a parser that drops unknown values returns [] and no error
  const lax = (/** @type {string} */ v) => v.split(',').filter((x) => x === 'hydration');
  assert.deepEqual(lax('hydrations'), []);
});

test('placeholders keep today\'s raw output', () => {
  const o = { nodes: { a: { id: 'a' } } };
  assert.equal(withHydration(o, ['hydration']), o);
  assert.equal(snapshotFor(o, []), o);
});
