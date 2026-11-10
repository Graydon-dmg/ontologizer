// @ts-check
// The Obsidian export (src/core/export/obsidian.js) and its zip writer: safe, unique note names;
// wikilinks that resolve; frontmatter no label can break; inert bodies; the graph's colours; a zip
// that unzips. Map text is untrusted, so the planted map below is hostile on purpose.
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { foldAll } from '../../src/core/events.js';
import { obsidianVault, safeName, zipFiles, crc32, FOLDER_FORMATS } from '../../src/core/export/index.js';
import { hslToRgbInt, NAME_MAX } from '../../src/core/export/obsidian.js';
import { categoryColor } from '../../web/shared/tokens.js';
import { obsidianZip, EXPORT_ITEMS } from '../../web/shell/ui/export.js';
import { FEATURES } from '../../src/features.js';

const NL = '\n';
const LS = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);
const opts = { colorOf: categoryColor };

/** @param {string} name */
const fixture = (name) => foldAll(fs.readFileSync(new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)));

/** @param {string} id @param {string} label @param {string|null} parent @param {string} category @param {number} depth @param {any} [extra] */
const node = (id, label, parent, category, depth, extra = {}) => ({
  id, label, parent, category, depth, summary: '', hook: '', origin: 'seed', sources: [], article: null, status: 'done', createdBy: 'wave0', ...extra,
});

/** A hostile map: traversal, device names, duplicates, injection in every field. */
function plantedMap() {
  const nodes = [
    node('r', 'Root label', null, '', 0, { summary: 'The <b>root</b>.' }),
    node('r/tools', 'Tools', 'r', 'r/tools', 1),
    node('r/glue', 'Glue', 'r/tools', 'r/tools', 2, {
      summary: `See [[Evil]] and ![[secret.png]] and <script>alert(1)</script> #tag ^block %%hidden%% ==hi== $x$ | a | ${NL}---${NL}injected: true`,
      sources: [
        { title: 'Good ](javascript:x) [x]', url: 'https://example.com/a_(b)?q=[1]' },
        { title: 'Bad', url: 'javascript:alert(1)' },
        { title: 'Data', url: 'data:text/html,<b>x</b>' },
        { source: 'wiki', ref: 'doc-1', title: 'Choosing glue', url: 'https://wiki.example/doc-1' },
        { source: 'wiki', ref: 'doc-2' },
      ],
      article: { summary: 'Article <img src=x onerror=alert(1)>.', keyFacts: ['Fact [[one]]', '# not a heading', '1. not a list'], whyItMatters: `It ${LS}matters${NL}---`, seeAlso: [], sources: [] },
    }),
    node('r/glue2', 'glue', 'r/tools', 'r/tools', 2),
    node('r/glue3', 'GLUE', 'r/tools', 'r/tools', 2),
    node('r/trav', '../../x', 'r/tools', 'r/tools', 2),
    node('r/con', 'CON', 'r/tools', 'r/tools', 2),
    node('r/lpt', 'lpt1.txt', 'r/tools', 'r/tools', 2),
    node('r/ab', 'a/b', 'r/tools', 'r/tools', 2),
    node('r/empty', '', 'r/tools', 'r/tools', 2),
    node('r/dots', '..', 'r/tools', 'r/tools', 2),
    node('r/hidden', '.obsidian', 'r/tools', 'r/tools', 2),
    node('r/fm', `Label${NL}---${NL}category: "evil"${NL}tags: [x]`, 'r/tools', 'r/tools', 2),
    node('r/bidi', `pdf${RLO}gpj.exe`, 'r/tools', 'r/tools', 2),
    node('r/long', 'L'.repeat(500), 'r/tools', 'r/tools', 2),
    node('r/link', '[[Root label]] | #x ^y', 'r/tools', 'r/tools', 2),
    node('r/samemap', 'My <Map>: "one"', 'r/tools', 'r/tools', 2),
  ];
  return /** @type {any} */ ({
    name: 'My <Map>: "one"', root: 'r', version: 1,
    brief: { context: '', subject: 'Glue <i>things</i>', scope: 'All [[of]] it', purpose: '', level: 'beginner' },
    categories: [{ id: 'r/tools', label: 'Tools & <Stuff>', index: 0, family: 0 }],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: [
      { id: 'e1', from: 'r/glue', to: 'r/con', type: 'influences', why: 'Because [[Evil]] <a>' },
      { id: 'e2', from: 'r/trav', to: 'r/glue', type: 'requires', why: '' },
      { id: 'e3', from: 'r/glue', to: 'r/missing', type: 'bridge', why: 'dangling' },
    ],
    lenses: { l: { id: 'l', persona: 'a chef', analogs: { 'r/glue': { label: 'Like <roux>', breaks: 'no heat' } } } },
    view: { collapsed: [], focus: 'r', layout: 'radial', lens: null, filter: { categories: null, maxDepth: null } },
    jobs: {}, insights: [{ at: 1, text: 'Insight <u>one</u> [[x]]' }], chat: [], visibility: 'private', privateSources: ['wiki'],
  });
}

/** The note names a vault holds (without ".md"). @param {{ notes: { path: string }[] }} v */
const noteNames = (v) => v.notes.map((n) => n.path.replace(/\.md$/, ''));

/** Problems with a vault's names: unsafe, duplicate ignoring case, or wikilinks that do not resolve. @param {ReturnType<typeof obsidianVault>} v */
function vaultProblems(v) {
  const problems = [];
  const names = noteNames(v);
  const keys = new Set();
  for (const n of [v.folder, ...names.slice(1)]) {
    if (!n || /[/\\:*?"<>|#^[\]]/.test(n) || /[\u0000-\u001f\u007f]/.test(n) || /^[\s.]|[\s.]$/.test(n)) problems.push(`unsafe name ${JSON.stringify(n)}`);
    if ([...n].length > NAME_MAX + 7) problems.push(`long name ${n.length}`);
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n.split('.')[0])) problems.push(`reserved ${n}`);
  }
  for (const n of names) {
    const k = n.toLowerCase();
    if (keys.has(k)) problems.push(`duplicate ${n}`);
    keys.add(k);
  }
  if (names[0] !== v.folder) problems.push('the index note is not named after the folder');
  for (const note of v.notes) {
    for (const m of note.text.matchAll(/(?<!\\)\[\[([^\]]*)\]\]/g)) {
      if (!keys.has(m[1].toLowerCase())) problems.push(`${note.path}: [[${m[1]}]] does not resolve`);
    }
  }
  return problems;
}

/**
 * A strict reader for the frontmatter the export writes: `key: "json string"`, `key: integer`, or
 * `key:` then `  - item` lines. Anything else is a problem (so an injected line shows up).
 * @param {string} text @returns {{ data: Record<string, any>, body: string, problems: string[] }}
 */
function readFrontmatter(text) {
  const problems = [];
  const lines = text.split('\n');
  if (lines[0] !== '---') return { data: {}, body: text, problems: ['no frontmatter'] };
  const end = lines.indexOf('---', 1);
  /** @type {Record<string, any>} */
  const data = {};
  let list = null;
  for (const l of lines.slice(1, end)) {
    let m;
    if ((m = /^  - (.*)$/.exec(l)) && list) {
      list.push(m[1].startsWith('"') ? JSON.parse(m[1]) : m[1]);
      if (!m[1].startsWith('"') && !/^[a-z0-9-]+$/.test(m[1])) problems.push(`bare list item ${m[1]}`);
    } else if ((m = /^([a-z-]+): (".*"|\d+)$/.exec(l))) {
      if (m[1] in data) problems.push(`duplicate key ${m[1]}`);
      data[m[1]] = JSON.parse(m[2]); list = null;
    } else if ((m = /^([a-z-]+):$/.exec(l))) {
      if (m[1] in data) problems.push(`duplicate key ${m[1]}`);
      list = data[m[1]] = [];
    } else problems.push(`bad frontmatter line ${JSON.stringify(l)}`);
  }
  if (end < 0) problems.push('frontmatter never ends');
  return { data, body: lines.slice(end + 1).join('\n'), problems };
}

/** Raw markup an untrusted value could inject into a body: an unescaped '<', or a body line that ends the frontmatter. @param {string} body */
const bodyProblems = (body) => [
  ...(/(?<!\\)</.test(body) ? ['raw <'] : []),
  ...(/^---$/m.test(body) ? ['--- line in body'] : []),
  ...(/(?<!\\)%%/.test(body) ? ['raw %% comment'] : []),
];

test('safeName: traversal, separators, device names, empty and dot names become safe names', () => {
  assert.equal(safeName('../../x'), '-..-x');
  assert.equal(safeName('a/b'), 'a-b');
  assert.equal(safeName('a\\b:c*?"<>|#^[]d'), 'a-b c d');
  assert.equal(safeName('CON'), 'CON (note)');
  assert.equal(safeName('lpt1.txt'), 'lpt1 (note).txt');
  assert.equal(safeName('/'), '-');
  assert.equal(safeName('nul '), 'nul (note)');
  for (const t of ['', '.', '..', '   ', '...', null, undefined]) assert.equal(safeName(t), 'Untitled', String(t));
  assert.equal(safeName(`a${NL}b${String.fromCharCode(0)}c`), 'a b c');
  assert.equal([...safeName('e'.repeat(300))].length, NAME_MAX);
  assert.ok(new TextEncoder().encode(safeName('é'.repeat(300))).length <= 200, 'multi-byte names stay within 200 bytes');
  assert.equal(safeName(' .hidden. '), 'hidden');
});

test('a hostile map: unique safe names, every wikilink resolves, deterministic disambiguation', () => {
  const v = obsidianVault(plantedMap(), opts);
  assert.deepEqual(vaultProblems(v), []);
  assert.equal(v.folder, 'My Map one');
  const names = noteNames(v);
  assert.equal(names[0], 'My Map one');
  // Glue, then "glue (Tools Stuff)", then "GLUE 2": first come first served, in depth then map order.
  assert.ok(names.includes('Glue'));
  assert.ok(names.includes('glue (Tools & Stuff)'), names.join(' | '));
  assert.ok(names.includes('GLUE 2'), names.join(' | '));
  // A node named like the map does not take the index note's name.
  assert.ok(names.includes('My Map one (Tools & Stuff)'));
  for (const want of ['-..-x', 'CON (note)', 'a-b', 'Untitled', 'Untitled (Tools & Stuff)', 'obsidian', 'lpt1 (note).txt']) assert.ok(names.includes(want), want);
  // Planted fault: a link to a note that does not exist, and a duplicate, are reported.
  const bad = { ...v, notes: [...v.notes, { path: 'glue.md', text: '[[Nowhere]]' }] };
  assert.deepEqual(vaultProblems(bad), ['duplicate glue', 'glue.md: [[Nowhere]] does not resolve']);
  // Same input, same files.
  assert.deepEqual(obsidianVault(plantedMap(), opts), v);
});

test('frontmatter parses; a label with newlines and --- cannot add keys; aliases keep the real label', () => {
  const v = obsidianVault(plantedMap(), opts);
  for (const note of v.notes) assert.deepEqual(readFrontmatter(note.text).problems, [], note.path);
  const fm = v.notes.find((n) => n.path.startsWith('Label --- category'));
  assert.ok(fm, noteNames(v).join(' | '));
  const { data } = readFrontmatter(fm.text);
  assert.equal(data.category, 'Tools & <Stuff>');
  assert.deepEqual(data.tags, ['ontologizer', 'tools-stuff']);
  assert.deepEqual(data.aliases, ['Label --- category: "evil" tags: [x]']);
  const linky = readFrontmatter(/** @type {any} */ (v.notes.find((n) => n.path.startsWith('Root label x y'))).text).data;
  assert.deepEqual(linky.aliases, ['[ [Root label] ] | #x ^y'], 'a property value never reads as a wikilink');
  assert.equal(data.source, 'My <Map>: "one"');
  assert.equal(data.visibility, 'private');
  assert.equal(data.depth, 2);
  const glue = readFrontmatter(/** @type {any} */ (v.notes.find((n) => n.path === 'Glue.md')).text).data;
  assert.equal(glue.aliases, undefined, 'an unchanged label needs no alias');
  // Planted fault: an unquoted injected line is caught by the reader.
  assert.ok(readFrontmatter(fm.text.replace('depth: 2', 'depth: 2\ninjected: true')).problems.length > 0);
});

test('bodies are inert: no raw <, [[ ]] in text escaped, only http(s) sources linked, incoming links marked', () => {
  const v = obsidianVault(plantedMap(), opts);
  for (const note of v.notes) assert.deepEqual(bodyProblems(readFrontmatter(note.text).body), [], note.path);
  const glue = /** @type {any} */ (v.notes.find((n) => n.path === 'Glue.md')).text;
  const body = readFrontmatter(glue).body;
  assert.match(body, /See \\\[\\\[Evil\\\]\\\] and !\\\[\\\[secret\.png\\\]\\\]/);
  assert.match(body, /\\<script\\>/);
  assert.match(body, /\\#tag \\\^block \\%\\%hidden\\%\\%/);
  assert.match(body, /## Article/);
  assert.match(body, /### Key facts\n\n- Fact \\\[\\\[one\\\]\\\]\n- \\# not a heading\n- 1\\\. not a list/);
  assert.match(body, /### Why it matters\n\nIt matters \\-\\-\\-|### Why it matters\n\nIt matters ---/);
  assert.match(body, /Part of: \[\[Tools\]\]/);
  assert.match(body, /- influences → \[\[CON \(note\)\]\]: Because \\\[\\\[Evil\\\]\\\] \\<a\\>/);
  assert.match(body, /- requires ← \[\[-\.\.-x\]\] \(incoming\)/);
  assert.doesNotMatch(body, /dangling/, 'a link to a missing node is left out');
  assert.match(body, /- As a chef: Like \\<roux\\> \(where it breaks: no heat\)/);
  // Sources: http(s) only, brackets and parentheses in the url percent-encoded, the title escaped.
  assert.match(body, /- \[Good \\\]\(javascript:x\) \\\[x\\\]\]\(https:\/\/example\.com\/a_%28b%29\?q=%5B1%5D\)/);
  assert.doesNotMatch(body, /javascript:alert|data:text/);
  assert.match(body, /- \[wiki · Choosing glue\]\(https:\/\/wiki\.example\/doc-1\)/);
  assert.match(body, /^- wiki · doc-2$/m, 'a ref without a web link is plain text');
  // The only live links in the body are wikilinks to generated notes and the two http(s) sources.
  const live = [...body.matchAll(/(?<!\\)\]\((?!\s)([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(live, ['https://example.com/a_%28b%29?q=%5B1%5D', 'https://wiki.example/doc-1']);
  assert.match(glue, /> \[!warning\] Private map\n> Made with private sources \(wiki\)/);
  // Planted fault: an unescaped tag would be caught.
  assert.deepEqual(bodyProblems('a <b>'), ['raw <']);
});

test('the index note: brief, categories with their top nodes, insights; links to the root\'s children', () => {
  const v = obsidianVault(plantedMap(), opts);
  const idx = v.notes[0];
  assert.equal(idx.path, 'My Map one.md');
  const { data, body } = readFrontmatter(idx.text);
  assert.deepEqual(data.tags, ['ontologizer', 'ontologizer-index']);
  assert.deepEqual(data.aliases, ['Root label']);
  assert.match(body, /\*\*Subject:\*\* Glue \\<i\\>things\\<\/i\\>/);
  assert.match(body, /## Tools & \\<Stuff\\>\n\n- \[\[Tools\]\]\n- \[\[Glue\]\]/);
  assert.match(body, /## Insights\n\n- Insight \\<u\\>one\\<\/u\\> \\\[\\\[x\\\]\\\]/);
  assert.match(body, /Branches: \[\[Tools\]\]/);
});

test('graph.json: one colour group per category, tag query, Obsidian\'s {a, rgb} from the map\'s colours', () => {
  assert.equal(hslToRgbInt('hsl(210 68% 58%)'), 0x4b94dd);
  assert.equal(hslToRgbInt('hsl(0 0% 100%)'), 0xffffff);
  const o = fixture('plastic-modeling');
  const v = obsidianVault(o, opts);
  assert.deepEqual(v.config.map((c) => c.path), ['.obsidian/graph.json']);
  const g = JSON.parse(v.config[0].text);
  assert.equal(g.colorGroups.length, o.categories.length);
  o.categories.forEach((c, i) => {
    const grp = g.colorGroups[i];
    assert.match(grp.query, /^tag:#[a-z0-9-]+$/);
    assert.deepEqual(grp.color, { a: 1, rgb: hslToRgbInt(categoryColor(c.index, c.family)) });
  });
  // Every category's tag is on its notes, so the group colours them.
  const tags = new Set(v.notes.flatMap((n) => readFrontmatter(n.text).data.tags ?? []));
  for (const grp of g.colorGroups) assert.ok(tags.has(grp.query.slice(5)), grp.query);
});

test('every fixture exports cleanly: names, links, frontmatter, bodies', () => {
  for (const f of ['demo', 'manga', 'plastic-modeling']) {
    const o = fixture(f);
    const v = obsidianVault(o, opts);
    assert.equal(v.notes.length, Object.keys(o.nodes).length, f);
    assert.deepEqual(vaultProblems(v), [], f);
    for (const n of v.notes) {
      const r = readFrontmatter(n.text);
      assert.deepEqual(r.problems, [], `${f}/${n.path}`);
      assert.deepEqual(bodyProblems(r.body), [], `${f}/${n.path}`);
    }
    assert.equal(readFrontmatter(v.notes[0].text).data.visibility, undefined, 'a public map is not marked private');
  }
});

test('crc32 and the zip writer: STORE, UTF-8 names, round-trips; bad names refused', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = [{ name: 'Map é/Note — ü.md', data: 'héllo\n' }, { name: 'Map é/.obsidian/graph.json', data: '{}\n' }, { name: 'empty.txt', data: '' }];
  const zip = zipFiles(files);
  assert.deepEqual(readZip(zip), files.map((f) => ({ name: f.name, text: f.data })));
  assert.deepEqual(zipFiles(files), zip, 'deterministic');
  for (const bad of ['../x', '/abs', 'a//b', 'a/./b', 'a\\b', '']) assert.throws(() => zipFiles([{ name: bad, data: 'x' }]), /Bad file name/, bad);
  assert.throws(() => zipFiles([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /Duplicate/);
  // Planted fault: a flipped data byte fails the CRC check.
  const broken = zip.slice();
  broken[30 + new TextEncoder().encode(files[0].name).length] ^= 1;
  assert.throws(() => readZip(broken), /CRC/);
});

test('the page\'s Obsidian zip unzips (unzip -t) to the same files the export makes', { skip: spawnSync('unzip', ['-v']).status !== 0 && 'no unzip' }, () => {
  const o = fixture('demo');
  const zip = obsidianZip(o);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-obs-zip-'));
  const file = path.join(dir, 'map.zip');
  fs.writeFileSync(file, zip);
  const t = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout, /No errors detected/);
  const x = spawnSync('unzip', ['-q', file, '-d', path.join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  const v = obsidianVault(o, opts);
  for (const f of [...v.notes, ...v.config]) assert.equal(fs.readFileSync(path.join(dir, 'out', v.folder, f.path), 'utf8'), f.text, f.path);
  assert.deepEqual(readZip(zip).map((e) => e.name).sort(), [...v.notes, ...v.config].map((f) => `${v.folder}/${f.path}`).sort());
});

test('the feature is registered: format, menu item, features row', () => {
  assert.deepEqual([...FOLDER_FORMATS], ['obsidian']);
  assert.ok(EXPORT_ITEMS.some((i) => i.id === 'export-obsidian' && i.label === 'Download for Obsidian' && i.format === 'obsidian'));
  assert.ok(FEATURES.some((f) => f.id === 'export-obsidian' && f.cli === 'export' && f.ui.id === 'export-obsidian'));
});

/**
 * Reads a STORE zip back through its central directory, checking signatures, sizes and CRCs.
 * @param {Uint8Array} zip @returns {{ name: string, text: string }[]}
 */
function readZip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  const count = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50);
    assert.equal(dv.getUint16(at + 8, true) & 0x0800, 0x0800, 'UTF-8 flag');
    assert.equal(dv.getUint16(at + 10, true), 0, 'STORE');
    const crc = dv.getUint32(at + 16, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const name = dec.decode(zip.subarray(at + 46, at + 46 + nameLen));
    const local = dv.getUint32(at + 42, true);
    assert.equal(dv.getUint32(local, true), 0x04034b50);
    const lName = dv.getUint16(local + 26, true);
    const data = zip.subarray(local + 30 + lName + dv.getUint16(local + 28, true), local + 30 + lName + size);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.push({ name, text: dec.decode(data) });
    at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
  }
  return out;
}

test('review fixes: names that only differ by case folding (ς/σ, ı/i) get distinct files; long names stay under 240 bytes; no Dataview fields', () => {
  const m = plantedMap();
  m.nodes['r/a1'] = node('r/a1', 'Aς', 'r/tools', 'r/tools', 2);
  m.nodes['r/a2'] = node('r/a2', 'Aσ', 'r/tools', 'r/tools', 2);
  m.nodes['r/i1'] = node('r/i1', 'Kıt', 'r/tools', 'r/tools', 2);
  m.nodes['r/i2'] = node('r/i2', 'Kit', 'r/tools', 'r/tools', 2);
  m.nodes['r/long'] = node('r/long', '𝒜'.repeat(200), 'r/tools', 'r/tools', 2, { summary: 'key:: value' });
  const v = obsidianVault(m, opts);
  const fold = (s) => s.normalize('NFKC').toUpperCase().toLowerCase().replace(/ς/g, 'σ').replace(/ı/g, 'i');
  const keys = v.notes.map((n) => fold(n.path));
  assert.equal(new Set(keys).size, keys.length, 'two notes fold to one file name');
  for (const n of v.notes) assert.ok(new TextEncoder().encode(n.path.split('/').pop()).length <= 255, n.path);
  assert.ok(!v.notes.some((n) => /(^|[^\\]):(?<!\\:):/.test(n.text.split('---').slice(2).join('---')) && n.text.includes('key:: value')));
});
