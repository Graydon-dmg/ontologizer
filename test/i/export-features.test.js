// @ts-check
// Graydon's rule for Part I4: every feature has a command and a button on the localhost page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES } from '../../src/features.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Command names main.js registers: each COMMANDS entry whose file exports that yargs command. */
async function registeredCommands() {
  const list = read('src/cli/main.js').match(/const COMMANDS = \[([\s\S]*?)\];/);
  const names = [...(list?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const out = new Set();
  for (const n of names) {
    const file = path.join(root, 'src', 'cli', 'commands', `${n}.js`);
    if (!fs.existsSync(file)) continue;
    const mod = (await import(new URL(`../../src/cli/commands/${n}.js`, import.meta.url).href)).default;
    out.add(String(mod.command).split(/[ [<]/)[0]);
  }
  return out;
}

/** Every shell module's source, joined: ids a page's scripts render (menu items, panels). */
function shellSource() {
  return fs.readdirSync(path.join(root, 'web', 'shell'), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => read(path.join('web', 'shell', String(f))))
    .join('\n');
}

/**
 * @param {typeof FEATURES} features @param {Set<string>} commands
 * @param {(page: string) => string} pageText @param {string} shell
 * @returns {string[]}
 */
function featureProblems(features, commands, pageText, shell) {
  const problems = [];
  for (const f of features) {
    if (!commands.has(f.cli)) problems.push(`${f.id}: command "${f.cli}" is not registered`);
    const inPage = new RegExp(`\\bid="${f.ui.id}"`).test(pageText(f.ui.page));
    const rendered = new RegExp(`['"]${f.ui.id}['"]`).test(shell);
    if (!inPage && !rendered) problems.push(`${f.id}: no element #${f.ui.id} on ${f.ui.page}`);
  }
  return problems;
}

const I4 = FEATURES.filter((f) => f.epic === 'I4');

test('the I4 rows are export (#export), the context pack (#export-context) and Obsidian (#export-obsidian), in the shared shape', () => {
  assert.deepEqual(I4.map((f) => [f.id, f.cli, f.ui.page, f.ui.id]), [
    ['export', 'export', 'web/index.html', 'export'],
    ['export-context', 'export', 'web/index.html', 'export-context'],
    ['export-obsidian', 'export', 'web/index.html', 'export-obsidian'],
  ]);
  for (const f of I4) assert.deepEqual(Object.keys(f).sort(), ['cli', 'epic', 'id', 'ui']);
});

test('every I4 feature has a registered command and its button on the page', async () => {
  assert.deepEqual(featureProblems(I4, await registeredCommands(), read, shellSource()), []);
});

test('planted fault: an Export menu without "Copy for an agent", or no export command, is reported', async () => {
  const shell = shellSource().replace(/export-context/g, 'export-other');
  assert.deepEqual(featureProblems(I4, await registeredCommands(), read, shell), ['export-context: no element #export-context on web/index.html']);
  const page = (/** @type {string} */ p) => read(p).replace('id="export"', 'id="exp0rt"');
  assert.ok(featureProblems(I4, await registeredCommands(), page, '').some((p) => p.startsWith('export: no element')));
  assert.deepEqual(featureProblems(I4, new Set(['load']), read, shellSource()), [
    'export: command "export" is not registered', 'export-context: command "export" is not registered',
    'export-obsidian: command "export" is not registered',
  ]);
});

test('the Export menu has the four contract items and Download for Obsidian, Copy for an agent at 4000 tokens', async () => {
  const { EXPORT_ITEMS, MENU_BUDGET, exportFileName } = await import('../../web/shell/ui/export.js');
  assert.deepEqual(EXPORT_ITEMS.map((i) => [i.id, i.label, i.format]), [
    ['export-html', 'Download page', 'html'],
    ['export-embed', 'Copy embed', 'embed'],
    ['export-json', 'Download JSON', 'json'],
    ['export-context', 'Copy for an agent', 'context'],
    ['export-obsidian', 'Download for Obsidian', 'obsidian'],
  ]);
  assert.equal(MENU_BUDGET, 4000);
  assert.equal(exportFileName('Scale Plastic Modeling', 'html'), 'scale-plastic-modeling.html');
  assert.equal(exportFileName('', 'json'), 'map.json');
});

test('the page mounts the Export menu and the server serves the bundle at /dist/', () => {
  assert.match(read('web/shell/main.js'), /\['export', mountExport\]/);
  assert.match(read('src/server/index.js'), /\['shell', 'shared', 'views', 'dev', 'dist'\]/);
});
