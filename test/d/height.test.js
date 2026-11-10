// @ts-check
// The 3D Height control (shell side): options, remembered choice, legend line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEIGHT_OPTIONS, HEIGHT_KEY, normalizeHeight, loadHeight, saveHeight, heightLegendLine, hasHeight } from '../../web/shell/height.js';
import { HEIGHT_MODES } from '../../web/views/sky/heights.js';

test('options: Off first, then the three modes, matching the view\'s modes', () => {
  assert.deepEqual(HEIGHT_OPTIONS.map((o) => o.label), ['Off', 'Learning order', 'Coverage', 'Connectedness']);
  assert.deepEqual(HEIGHT_OPTIONS.map((o) => o.value), [...HEIGHT_MODES]);
});

test('the choice is remembered; anything unknown or unreadable is Off', () => {
  /** @type {Map<string, string>} */
  const m = new Map();
  const storage = { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); } };
  assert.equal(loadHeight(storage), 'off');
  saveHeight(storage, 'coverage');
  assert.equal(m.get(HEIGHT_KEY), 'coverage');
  assert.equal(loadHeight(storage), 'coverage');
  saveHeight(storage, 'bogus');
  assert.equal(loadHeight(storage), 'off');
  assert.equal(loadHeight({ getItem: () => { throw new Error('blocked'); } }), 'off');
  assert.equal(loadHeight(null), 'off');
  assert.doesNotThrow(() => saveHeight({ setItem: () => { throw new Error('quota'); } }, 'learning'));
  assert.equal(normalizeHeight('connectedness'), 'connectedness');
});

test('legend line: one line per mode, only while on, only in a view that draws height', () => {
  assert.equal(heightLegendLine('learning', true), 'Height: learning order (higher = needs more first)');
  assert.equal(heightLegendLine('coverage', true), 'Height: coverage (higher = better researched)');
  assert.equal(heightLegendLine('connectedness', true), 'Height: connectedness (higher = more links)');
  assert.equal(heightLegendLine('off', true), '');
  assert.equal(heightLegendLine('learning', false), '', 'hidden in 2D');
  assert.equal(hasHeight({ setHeight() {} }), true);
  assert.equal(hasHeight({}), false);
  assert.equal(hasHeight(null), false);
});
