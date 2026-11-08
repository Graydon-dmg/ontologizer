// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeThrottle } from '../../web/views/graph/minimap.js';

/** Count fires of `gate` for 20 calls spread across 1 s of a fake clock. */
function firesIn1s(/** @type {(ms: number, now: () => number) => () => boolean} */ make) {
  let t = 0;
  const gate = make(100, () => t);
  let fires = 0;
  for (let i = 0; i < 20; i++) {
    t = i * 50;
    if (gate()) fires++;
  }
  return fires;
}
const check = (/** @type {any} */ make) => assert.ok(firesIn1s(make) <= 10, 'throttle fired more than 10 times in 1 s');
const noopThrottle = () => () => true;

test('throttle: 20 calls in 1 s fire at most 10 times', () => {
  check(makeThrottle);
  assert.equal(firesIn1s(makeThrottle), 10);
});

test('throttle: planted fault (fires every call) is caught', () => {
  assert.throws(() => check(noopThrottle));
});

test('throttle: fires again once the interval has passed', () => {
  let t = 0;
  const gate = makeThrottle(100, () => t);
  assert.equal(gate(), true);
  t = 99; assert.equal(gate(), false);
  t = 100; assert.equal(gate(), true);
});

test('module imports in Node without a DOM', async () => {
  const m = await import('../../web/views/graph/minimap.js');
  assert.equal(typeof m.createMinimap, 'function');
});
