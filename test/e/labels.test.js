// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLabels } from '../../web/views/graph/math.js';

const box = (x, y) => ({ x, y, w: 60, h: 14 });
const items = [
  { id: 'small', forced: false, depth: 2, r: 6, box: box(0, 0) },
  { id: 'big', forced: false, depth: 2, r: 12, box: box(30, 5) },     // overlaps small
  { id: 'deep', forced: false, depth: 3, r: 20, box: box(50, 8) },    // overlaps big; child ring loses
  { id: 'clear', forced: false, depth: 3, r: 5, box: box(500, 500) }, // overlaps nothing
  { id: 'focus', forced: true, depth: 4, r: 5, box: box(10, 2) },     // forced: always shown
];

/** @param {(i: typeof items) => Set<string>} impl */
function check(impl) {
  const s = impl(items);
  assert.ok(s.has('focus'), 'forced label shown');
  assert.ok(s.has('clear'), 'non-colliding label shown');
  assert.ok(!s.has('small') && !s.has('big'), 'labels colliding with the forced one are skipped');
  assert.ok(!s.has('deep'), 'deeper label colliding with a placed one is skipped');
  const s2 = impl(items.filter((i) => i.id !== 'focus'));
  assert.ok(s2.has('big') && !s2.has('small'), 'larger node wins a tie at the same depth');
  assert.ok(!s2.has('deep'), 'parent ring placed before child ring');
}

test('placeLabels skips colliding deeper/smaller labels; catches show-everything and wrong order', () => {
  check(placeLabels);
  assert.throws(() => check((i) => new Set(i.map((x) => x.id))), 'planted fault: shows every label');
  // planted fault: smaller-first ordering
  const smallFirst = (/** @type {typeof items} */ i) => placeLabels(i.map((x) => ({ ...x, r: -x.r })));
  assert.throws(() => check(smallFirst), 'planted fault: smaller-before-larger order');
});

test('placeLabels: priority beats depth and size (hybrids before other depth-2 labels); catches priority ignored', () => {
  const its = [
    { id: 'other', forced: false, priority: 0, depth: 2, r: 15, box: box(0, 0) },
    { id: 'hybrid', forced: false, priority: 2, depth: 2, r: 6, box: box(20, 4) },
  ];
  const chk = (/** @type {typeof placeLabels} */ f) => { const s = f(its); assert.ok(s.has('hybrid') && !s.has('other')); };
  chk(placeLabels);
  assert.throws(() => chk((i) => placeLabels(i.map((x) => ({ ...x, priority: 0 })))), 'planted fault: priority ignored');
});

test('placeLabels: a label blocked on the right takes its next free spot; catches a placer that only tries the first spot', () => {
  const its = [
    { id: 'a', forced: false, depth: 2, r: 9, boxes: [box(0, 0)] },
    { id: 'b', forced: false, depth: 2, r: 5, boxes: [box(20, 2), box(-70, 2), box(10, 30)] }, // right and left blocked/ok
  ];
  const chk = (/** @type {typeof placeLabels} */ f) => {
    const s = f(its);
    assert.ok(s.has('a') && s.has('b'), 'both labels drawn');
    assert.equal(s.get('b'), 1, 'b takes its second spot');
  };
  chk(placeLabels);
  const firstOnly = (/** @type {any} */ i) => placeLabels(i.map((/** @type {any} */ x) => ({ ...x, boxes: x.boxes.slice(0, 1) })));
  assert.throws(() => chk(firstOnly), 'planted fault: only the first spot is tried');
});

test('placeLabels: a must label (hybrid) is drawn even with no free spot; catches must ignored', () => {
  const its = [
    { id: 'cat', forced: true, depth: 1, r: 12, boxes: [box(0, 0)] },
    { id: 'hyb', forced: false, must: true, depth: 2, r: 5, boxes: [box(10, 0), box(20, 4)] }, // every spot blocked
  ];
  const chk = (/** @type {typeof placeLabels} */ f) => assert.ok(f(its).has('hyb'));
  chk(placeLabels);
  assert.throws(() => chk((i) => placeLabels(i.map((x) => ({ ...x, must: false })))), 'planted fault: must ignored');
});
