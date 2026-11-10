// @ts-check
// `ontologizer export <map> --format obsidian --out <dir>`: writes the map's folder into <dir>,
// refuses an existing one without --force, never writes outside it or through a symbolic link, and
// writes .obsidian/graph.json only into a fresh folder that is not already inside a vault.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { openStore } from '../../src/core/store.js';
import { complete } from '../../src/cli/complete.js';
import { obsidianVault } from '../../src/core/export/index.js';
import { categoryColor } from '../../web/shared/tokens.js';
import { foldAll } from '../../src/core/events.js';
import { fixtureEvents } from './build-check.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-obs-'));
const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; return true; } });

/** @param {string} home @param {string[]} args */
async function run(home, args) {
  const stdout = cap(); const stderr = cap();
  const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home } });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

/** Every file and link under a folder, relative, sorted. @param {string} dir @returns {string[]} */
function tree(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

test('export demo --format obsidian --out <dir> writes the vault folder: notes, index, graph colours', async () => {
  const home = tmp(); const root = tmp(); const out = path.join(root, 'vaults', 'new');
  const r = await run(home, ['export', 'demo', '--format', 'obsidian', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const v = obsidianVault(foldAll(fixtureEvents('demo')), { colorOf: categoryColor });
  const folder = path.join(out, v.folder);
  assert.match(r.stdout, new RegExp(`Wrote ${v.notes.length} notes for Obsidian to .*${v.folder}`));
  assert.match(r.stdout, /Open the folder in Obsidian as a vault, or drop it into an existing vault\./);
  assert.match(r.stdout, /category colours in \.obsidian\/graph\.json/);
  // Exactly the export's files, byte for byte, and nothing anywhere else under the temp root.
  assert.deepEqual(tree(root), [...v.notes, ...v.config].map((f) => path.join('vaults', 'new', v.folder, f.path)).sort());
  for (const f of [...v.notes, ...v.config]) assert.equal(fs.readFileSync(path.join(folder, f.path), 'utf8'), f.text);
  assert.deepEqual(openStore(home).list({ drafts: true }), [], 'a bundled map is read, not imported');
});

test('an existing folder is refused without --force; --force rewrites the notes, keeps other files and .obsidian', async () => {
  const home = tmp(); const out = tmp();
  openStore(home).importEvents('plastic-modeling', fixtureEvents('plastic-modeling'));
  assert.equal((await run(home, ['export', 'plastic', '--format', 'obsidian', '--out', out])).code, 0);
  const folder = path.join(out, fs.readdirSync(out)[0]);
  const graph = path.join(folder, '.obsidian', 'graph.json');
  fs.writeFileSync(graph, '{"mine":true}');
  fs.writeFileSync(path.join(folder, 'My own note.md'), 'mine');
  const note = path.join(folder, 'Adhesives.md');
  fs.writeFileSync(note, 'edited');

  const again = await run(home, ['export', 'plastic', '--format', 'obsidian', '--out', out]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists: pass --force/);
  assert.equal(fs.readFileSync(note, 'utf8'), 'edited', 'nothing written on refusal');

  const forced = await run(home, ['export', 'plastic', '--format', 'obsidian', '--out', out, '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.doesNotMatch(forced.stdout, /graph\.json/);
  assert.notEqual(fs.readFileSync(note, 'utf8'), 'edited');
  assert.equal(fs.readFileSync(graph, 'utf8'), '{"mine":true}', 'never overwrites an existing .obsidian');
  assert.equal(fs.readFileSync(path.join(folder, 'My own note.md'), 'utf8'), 'mine');
});

test('into an existing vault: the folder goes in, the vault\'s own .obsidian is left alone and none is nested', async () => {
  const home = tmp(); const vault = tmp();
  fs.mkdirSync(path.join(vault, '.obsidian'));
  fs.writeFileSync(path.join(vault, '.obsidian', 'graph.json'), '{}');
  const r = await run(home, ['export', 'demo', '--format', 'obsidian', '--out', vault]);
  assert.equal(r.code, 0, r.stderr);
  const folder = fs.readdirSync(vault).find((n) => n !== '.obsidian');
  assert.ok(folder);
  assert.equal(fs.existsSync(path.join(vault, folder, '.obsidian')), false);
  assert.equal(fs.readFileSync(path.join(vault, '.obsidian', 'graph.json'), 'utf8'), '{}');
});

test('never writes outside --out: hostile labels stay inside; a symlinked note or folder is refused', async () => {
  const home = tmp(); const root = tmp(); const out = path.join(root, 'out');
  const ev = fixtureEvents('plastic-modeling');
  const kid = ev.find((e) => e.t === 'node.added' && e.node.depth === 2);
  const evil = ['../../escaped', '/etc/passwd', '..', 'C:\\Windows\\x', '.obsidian/graph'];
  const events = [{ ...ev[0], name: '../../outside' }, ...ev.slice(1),
    ...evil.map((label, i) => ({ t: 'node.added', at: 5000 + i, node: { ...kid.node, id: `${kid.node.id}-evil-${i}`, label } }))];
  openStore(home).importEvents('evil', events);
  const r = await run(home, ['export', 'evil', '--format', 'obsidian', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const files = tree(root);
  assert.ok(files.every((f) => f.startsWith(`out${path.sep}`) && !f.split(path.sep).includes('..')), files.join('\n'));
  const [folder] = fs.readdirSync(out);
  assert.equal(folder, '-..-outside');
  for (const f of files.map((x) => x.split(path.sep).slice(2).join('/'))) assert.ok(f === '.obsidian/graph.json' || !f.includes('/'), f);

  // A note in the folder that is a symbolic link to a file elsewhere: refused, the target untouched.
  const target = path.join(root, 'victim.txt');
  fs.writeFileSync(target, 'keep');
  const note = path.join(out, folder, 'Adhesives.md');
  fs.rmSync(note);
  fs.symlinkSync(target, note);
  const viaLink = await run(home, ['export', 'evil', '--format', 'obsidian', '--out', out, '--force']);
  assert.equal(viaLink.code, 1);
  assert.match(viaLink.stderr, /symbolic link/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');

  // The map's folder itself a symbolic link: refused.
  const out2 = path.join(root, 'out2');
  fs.mkdirSync(out2);
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(out2, folder));
  const linkDir = await run(home, ['export', 'evil', '--format', 'obsidian', '--out', out2, '--force']);
  assert.equal(linkDir.code, 1);
  assert.match(linkDir.stderr, /not a plain folder/);
  assert.equal(fs.existsSync(path.join(root, 'elsewhere')), false);
});

test('bad combinations: --force elsewhere, --out a file, page-only flags; completion knows obsidian and --force', async () => {
  const home = tmp(); const file = path.join(tmp(), 'f.txt');
  fs.writeFileSync(file, 'x');
  for (const [args, msg] of /** @type {[string[], RegExp][]} */ ([
    [['export', 'demo', '--format', 'json', '--force'], /--force only applies to --format obsidian/],
    [['export', 'demo', '--format', 'obsidian', '--out', file], /is a file/],
    [['export', 'demo', '--format', 'obsidian', '--3d'], /--3d only applies/],
    [['export', 'demo', '--format', 'obsidian', '--include-chat'], /--include-chat only applies/],
  ])) {
    const r = await run(home, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, msg);
  }
  assert.deepEqual(complete(['export', 'demo', '--format', 'o']), ['obsidian']);
  assert.deepEqual(complete(['export', 'demo', '--for']), ['--format', '--force']);
});
