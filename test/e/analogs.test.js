// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLabels, spotBoxes, truncateAnalog, LABEL_GEOM } from '../../web/views/graph/math.js';

const W = (/** @type {string} */ s) => LABEL_GEOM.charW * s.length;
const AW = (/** @type {string} */ s) => LABEL_GEOM.analogCharW * truncateAnalog(s).length;
/** @param {string} id @param {number} cx @param {number} cy @param {Partial<import('../../web/views/graph/math.js').LabelEntry>} [o] */
const node = (id, cx, cy, o = {}) => ({ id, forced: false, depth: 2, r: 6, cx, cy, R: 6, w: W(id), aw: 0, ...o });

// "Water Quality" with a long analog, and "Water Hardness" just below it: the analog line would
// run into Water Hardness's label on every side, but both node labels fit on their own.
const scene = () => [
  node('Water Quality', 100, 100, { aw: AW('water for boiling pasta and stock'), priority: 1 }),
  node('Water Hardness', 100, 116),
];

/** No two drawn boxes overlap (analog lines included). */
function noOverlap(/** @type {typeof planLabels} */ plan, /** @type {typeof spotBoxes} */ boxes = spotBoxes) {
  const es = scene();
  const out = plan(es);
  const drawn = es.filter((e) => out.has(e.id)).map((e) => {
    const at = /** @type {any} */ (out.get(e.id));
    return spotBoxes(e, at.analog)[at.spot]; // the true box, analog included
  });
  for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++) {
    const a = drawn[i], b = drawn[j];
    assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), 'drawn label/analog boxes overlap');
  }
  assert.ok(out.has('Water Quality') && out.has('Water Hardness'), 'both node labels drawn');
}

test('an analog joins its label in collision culling; catches an analog box that ignores collisions', () => {
  noOverlap(planLabels);
  /** planted fault: the analog line is left out of the box that is checked for collisions */
  const labelOnlyBoxes = (/** @type {any} */ e, /** @type {boolean} */ _withAnalog) => spotBoxes(e, false);
  assert.throws(() => noOverlap((es) => planLabels(es, labelOnlyBoxes)));
});

/** An analog is only ever drawn with its own node label: B is boxed in on all four sides, so neither shows. */
function analogNeedsLabel(/** @type {typeof planLabels} */ plan) {
  const blocker = (/** @type {string} */ id, /** @type {number} */ x, /** @type {number} */ y) => node(id, x, y, { forced: true, depth: 1, w: 80 });
  const es = [
    blocker('right-of-B', 100, 100), blocker('left-of-B', 60, 100), blocker('above-B', 80, 85), blocker('below-B', 80, 115),
    node('B', 104, 100, { aw: AW('an analog for B') }),
  ];
  const out = plan(es);
  assert.ok(!out.has('B'), 'B label culled and no analog for it');
  for (const [id, at] of out) if (at.analog) assert.ok(es.find((e) => e.id === id)?.aw, 'analog only where one exists');
}

test('a culled label never shows an analog; catches an analog shown under a culled label', () => {
  analogNeedsLabel(planLabels);
  /** planted fault: analogs drawn for every node with one, even when the label was culled */
  const leaky = (/** @type {any[]} */ es) => {
    const out = planLabels(es);
    for (const e of es) if (e.aw > 0 && !out.has(e.id)) out.set(e.id, { spot: 0, analog: true });
    return out;
  };
  assert.throws(() => analogNeedsLabel(leaky));
});

test('a hovered/focused node keeps its analog even when crowded; analogs are truncated to 30 characters', () => {
  const es = scene();
  es[0] = { ...es[0], forced: true, full: true };
  assert.equal(/** @type {any} */ (planLabels(es).get('Water Quality')).analog, true);
  const long = 'the slow reduction of a classic French veal stock';
  assert.equal(truncateAnalog(long).length, 30);
  assert.ok(truncateAnalog(long).endsWith('…'));
  assert.equal(truncateAnalog('short'), 'short');
});
