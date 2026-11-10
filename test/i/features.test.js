// @ts-check
// Every feature in src/features.js has a registered CLI command and its button's element id in its page.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FEATURES } from '../../src/features.js';
import { OPS } from '../../src/ops.js';
import { COMMANDS } from '../../src/cli/main.js';

const ROOT = new URL('../../', import.meta.url);

/** The command names main() registers: each module's `command`, first word. */
async function registered() {
  /** @type {Set<string>} */
  const names = new Set();
  for (const file of COMMANDS) {
    const url = new URL(`src/cli/commands/${file}.js`, ROOT);
    if (!fs.existsSync(url)) continue;
    const mod = (await import(url.href)).default;
    for (const c of [mod.command, ...(mod.aliases ?? [])].flat()) names.add(String(c).split(' ')[0]);
  }
  return names;
}

/**
 * A button is "in the page" when its id is in the page's HTML, or is a quoted string in a module the
 * page loads (a menu item the shell renders, e.g. `id: 'export-context'`).
 * @param {Array<{ id: string, epic: string, cli: string, ui: { page: string, id: string } }>} features
 * @param {Set<string>} commands
 * @param {(page: string) => string|null} readPage
 * @param {(page: string) => string} [readModules] the text of the modules the page loads
 * @returns {string[]}
 */
function featureProblems(features, commands, readPage, readModules = () => '') {
  const problems = [];
  const ids = new Set();
  for (const f of features) {
    if (ids.has(f.id)) problems.push(`${f.id}: listed twice`);
    ids.add(f.id);
    if (!/^I\d$/.test(f.epic)) problems.push(`${f.id}: epic "${f.epic}"`);
    if (!commands.has(f.cli)) problems.push(`${f.id}: command "${f.cli}" is not registered`);
    const html = readPage(f.ui?.page);
    if (html === null) problems.push(`${f.id}: page ${f.ui?.page} does not exist`);
    else if (!new RegExp(`\\bid=["']${f.ui.id}["']`).test(html) && !new RegExp(`['"\`]${f.ui.id}['"\`]`).test(readModules(f.ui.page))) {
      problems.push(`${f.id}: no element #${f.ui.id} in ${f.ui.page}`);
    }
  }
  return problems;
}

/** @param {string} dir @returns {string[]} */
function jsUnder(dir) {
  /** @type {string[]} */
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...jsUnder(p));
    else if (e.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

/** The modules a page loads: the shell's, and the page's own folder's. @param {string} page */
const readModules = (page) => {
  const root = new URL('.', ROOT).pathname;
  const own = page.split('/').slice(0, -1).join('/');
  return [...jsUnder(`${root}web/shell`), ...(own && own !== 'web' ? jsUnder(`${root}${own}`) : [])].join('\n');
};

/** @param {string} page */
const readPage = (page) => {
  try { return fs.readFileSync(new URL(page, ROOT), 'utf8'); } catch { return null; }
};

test('every feature has a registered command and its button in its page', async () => {
  const commands = await registered();
  assert.ok(FEATURES.length >= 3);
  assert.deepEqual(featureProblems(FEATURES, commands, readPage, readModules), []);
  for (const id of ['serve', 'status', 'token']) assert.ok(FEATURES.some((f) => f.id === id && f.epic === 'I1'), id);
  // The map page has the Server panel's mount point too (shown in service mode only).
  assert.match(fs.readFileSync(new URL('web/index.html', ROOT), 'utf8'), /<div id="server-panel" hidden><\/div>/);
});

test('planted faults: a feature row with a missing button, or an unregistered command, is reported', async () => {
  const commands = await registered();
  const missingButton = [{ id: 'x', epic: 'I1', cli: 'serve', ui: { page: 'web/home/index.html', id: 'no-such-button' } }];
  assert.deepEqual(featureProblems(missingButton, commands, readPage, readModules), ['x: no element #no-such-button in web/home/index.html']);
  // A button the shell renders counts (its id is a quoted string in a shell module); a missing one does not.
  const rendered = [{ id: 'r', epic: 'I4', cli: 'serve', ui: { page: 'web/index.html', id: 'menu-only' } }];
  assert.deepEqual(featureProblems(rendered, commands, readPage, () => "const ITEMS = [{ id: 'menu-only' }];"), []);
  assert.equal(featureProblems(rendered, commands, readPage, () => "const ITEMS = [{ id: 'other' }];").length, 1);
  const missingCommand = [{ id: 'y', epic: 'I1', cli: 'nope', ui: { page: 'web/home/index.html', id: 'new-map' } }];
  assert.deepEqual(featureProblems(missingCommand, commands, readPage), ['y: command "nope" is not registered']);
  const missingPage = [{ id: 'z', epic: 'I1', cli: 'serve', ui: { page: 'web/nope.html', id: 'new-map' } }];
  assert.equal(featureProblems(missingPage, commands, readPage).length, 1);
});

test('every op has a registered command and its button in its page', async () => {
  const commands = await registered();
  const rows = OPS.map((op) => ({ id: op.name, epic: 'I3', cli: op.cli, ui: op.ui }));
  assert.ok(rows.length > 20);
  assert.deepEqual(featureProblems(rows, commands, readPage, readModules), []);
});

test('planted fault: an op whose ui id is not in its page is reported', async () => {
  const commands = await registered();
  const bad = { ...OPS[0], name: 'bad_op', ui: { ...OPS[0].ui, id: 'no-such-button' } };
  const rows = [bad].map((op) => ({ id: op.name, epic: 'I3', cli: op.cli, ui: op.ui }));
  assert.deepEqual(featureProblems(rows, commands, readPage, readModules), [`bad_op: no element #no-such-button in ${bad.ui.page}`]);
});
