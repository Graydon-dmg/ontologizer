// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicker, tickerItem } from '../../web/shell/ticker.js';

function fake() {
  let now = 0; let seq = 0; const timers = new Map();
  return {
    setTimeout: (f, ms) => { const id = ++seq; timers.set(id, { f, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].f();
      }
      now = end;
    },
  };
}

// planted fault: shows every pushed item immediately, so two are visible at once
function brokenTicker({ show }) { return { push: (item) => show(item) }; }

function check(make) {
  const t = fake(); const shown = [];
  const tk = make({ show: (i) => shown.push(i ? i.text : null), setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, holdMs: 4000 });
  tk.push({ text: 'a' }); tk.push({ text: 'b' }); tk.push({ text: 'c' });
  assert.deepEqual(shown, ['a'], 'only one at a time');
  t.advance(3999);
  assert.deepEqual(shown, ['a']);
  t.advance(1);
  assert.deepEqual(shown, ['a', 'c'], 'newest pending first');
  t.advance(4000);
  assert.deepEqual(shown, ['a', 'c', 'b']);
  t.advance(4000);
  assert.deepEqual(shown, ['a', 'c', 'b', null]);
}

test('hooks and insights produce ticker items, other events do not', () => {
  const add = { t: 'node.added', at: 1, node: { id: 'x/y', label: 'Y', hook: 'A hook' } };
  assert.deepEqual(tickerItem(add, /** @type {any} */ ({})), { text: 'A hook', nodeId: 'x/y' });
  assert.deepEqual(tickerItem({ t: 'insight', at: 1, text: 'Hm', nodeId: 'x/y' }, /** @type {any} */ ({})), { text: 'Hm', nodeId: 'x/y' });
  assert.equal(tickerItem({ t: 'node.added', at: 1, node: { id: 'q', label: 'Q' } }, /** @type {any} */ ({})), null);
  assert.equal(tickerItem({ t: 'job.done', at: 1, job: { id: 'j' } }, /** @type {any} */ ({})), null);
});

test('ticker shows one item at a time, newest first, then clears', () => {
  check(createTicker);
  assert.throws(() => check(brokenTicker));
});
