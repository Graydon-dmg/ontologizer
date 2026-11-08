// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { menuItems, runMenuItem } from '../../web/shell/menu.js';
import { filterValue, sendFilter } from '../../web/shell/filter.js';
import { isValidAction } from '../../web/shell/actions.js';
import { resolveTheme, loadChoice, saveChoice, applyTheme, THEME_KEY } from '../../web/shell/theme.js';
import * as tokens from '../../web/shared/tokens.js';

const events = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const onto = foldAll(events);
const TOOLS = 'plastic-modeling/tools';

function fakeShell() {
  /** @type {any[]} */ const acts = [];
  /** @type {string[]} */ const opened = [];
  /** @type {any[]} */ const filters = [];
  return {
    acts, opened, filters,
    act: (/** @type {any} */ a) => { acts.push(a); return Promise.resolve({ ok: true }); },
    openExplain: (/** @type {string} */ id) => { opened.push(id); },
    activeView: () => ({ setFilter: (/** @type {any} */ f) => filters.push(f) }),
  };
}

/** @param {typeof runMenuItem} run */
function checkMenuClicks(run) {
  const shell = fakeShell();
  const items = menuItems(onto.nodes[TOOLS], onto);
  for (const item of items) run(item, TOOLS, shell);
  const want = items.filter((i) => i.action).map((i) => i.action);
  assert.deepEqual(shell.acts, want);
  assert.ok(shell.acts.length >= 4);
  assert.ok(shell.acts.every(isValidAction));
  assert.deepEqual(shell.opened, [TOOLS]); // Explain opens the panel at once
}

test('clicking a menu item sends its action through shell.act (Explain also opens the panel)', () => {
  checkMenuClicks(runMenuItem);
});

test('planted fault: a menu click that only closes the menu is caught', () => {
  const bad = /** @type {typeof runMenuItem} */ (() => undefined);
  assert.throws(() => checkMenuClicks(bad));
});

/** @param {typeof sendFilter} send */
function checkFilterSends(send) {
  const shell = fakeShell();
  const value = filterValue(['a', 'b', 'c'], ['a', 'b', 'c'], '1');
  assert.deepEqual(value, { categories: null, maxDepth: 1 });
  send(shell, value);
  assert.deepEqual(shell.filters, [value]);
  assert.deepEqual(shell.acts, [{ type: 'filter', value: { categories: null, maxDepth: 1 } }]);
}

test('setting max depth sends a filter action (so it persists), and applies it to the view', () => {
  checkFilterSends(sendFilter);
  assert.deepEqual(filterValue(['a'], ['a', 'b'], ''), { categories: ['a'], maxDepth: null });
});

test('planted fault: a filter that only calls view.setFilter is caught', () => {
  const bad = /** @type {typeof sendFilter} */ ((shell, value) => { shell.activeView().setFilter(value); });
  assert.throws(() => checkFilterSends(bad));
});

test('theme: System follows the OS, Light/Dark set data-theme, the choice is remembered, onto-theme fires', () => {
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  /** @type {Record<string, string>} */ const store = {};
  const storage = { getItem: (/** @type {string} */ k) => store[k] ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store[k] = v; } };
  assert.equal(loadChoice(storage), 'system');
  saveChoice(storage, 'light');
  assert.equal(store[THEME_KEY], 'light');
  assert.equal(loadChoice(storage), 'light');
  assert.equal(loadChoice({ getItem: () => { throw new Error('blocked'); } }), 'system');
  /** @type {any[]} */ const fired = [];
  /** @type {Record<string, string>} */ const vars = {};
  const doc = { documentElement: { dataset: /** @type {any} */ ({}), style: { setProperty: (/** @type {string} */ k, /** @type {string} */ v) => { vars[k] = v; } } },
                dispatchEvent: (/** @type {any} */ e) => fired.push(e) };
  applyTheme(doc, 'light', false, tokens, (t, init) => ({ type: t, ...init }));
  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(vars['--bg'], tokens.THEME.light.bg);
  applyTheme(doc, 'system', false, tokens, (t, init) => ({ type: t, ...init }));
  assert.equal('theme' in doc.documentElement.dataset, false);
  assert.equal(vars['--bg'], tokens.THEME.dark.bg);
  assert.deepEqual(fired.map((e) => [e.type, e.detail.theme]), [['onto-theme', 'light'], ['onto-theme', 'dark']]);
});
