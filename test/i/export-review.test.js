// @ts-check
process.env.ONTOLOGIZER_KEYRING = 'none'; delete process.env.ANTHROPIC_API_KEY; process.env.ONTOLOGIZER_ENGINE = 'stub'; process.env.ONTOLOGIZER_NO_UPDATE_CHECK = '1';
// Review fixes for the formats: json leaves the chat out unless asked; html and embed carry only
// what the embed shows (no job errors, no brief context, no chat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { openStore } from '../../src/core/store.js';
import { exportMap, exportSnapshot } from '../../src/core/export/index.js';
import { readMapData } from '../../web/embed/data.js';
import { bundleText, demo, dataTagText, fixtureEvents } from './build-check.js';

const JOB_ERROR = 'ENOENT: /Users/someone-private/secret-folder/notes.txt';
const CONTEXT_MARK = 'PRIVATE-CONTEXT-MARKER-7f3a';
const CHAT_MARK = 'CHAT-QUESTION-MARKER-91c2';

/** The demo with a failed job, a brief context and a chat planted in it. @returns {any} */
function planted() {
  const o = /** @type {any} */ (demo());
  const nodeId = Object.keys(o.nodes)[1];
  return {
    ...o,
    brief: { ...o.brief, context: `I am writing my thesis; ${CONTEXT_MARK}` },
    jobs: { ...o.jobs, jx: { id: 'jx', kind: 'research', nodeId, state: 'failed', error: JOB_ERROR }, jd: { id: 'jd', kind: 'research', nodeId, state: 'done' } },
    chat: [
      { role: 'user', chatId: 'main', msgId: 'm1', text: CHAT_MARK, images: [{ hash: 'abc123', mime: 'image/png', w: 1, h: 1 }], at: 1 },
      { role: 'error', chatId: 'main', msgId: 'm2', replyTo: 'm1', text: JOB_ERROR, at: 2 },
    ],
  };
}

test('json leaves the chat out by default, same shape otherwise; includeChat keeps it', () => {
  const o = planted();
  const text = exportMap(o, { format: 'json' });
  assert.ok(!text.includes(CHAT_MARK) && !text.includes('abc123'), 'no chat text or attachment ids');
  assert.deepEqual(JSON.parse(text), { ...o, chat: [] });
  assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(o), 'same top-level keys, same order');
  const all = exportMap(o, { format: 'json', includeChat: true });
  assert.equal(all, JSON.stringify(o));
});

test('html and embed carry no job error, no brief context, no chat, no insights', async () => {
  const bundle = await bundleText();
  const o = planted();
  for (const format of /** @type {const} */ (['html', 'embed'])) {
    const out = exportMap(o, { format, bundle });
    for (const mark of [JOB_ERROR, '/Users/someone-private', CONTEXT_MARK, CHAT_MARK, 'abc123']) {
      assert.ok(!out.includes(mark), `${format} leaks ${mark}`);
    }
    const r = readMapData(dataTagText(out));
    assert.ok(r.ok, format);
    const snap = /** @type {any} */ (r.ok && r.ontology);
    assert.deepEqual(snap.jobs, {});
    assert.deepEqual(snap.chat, []);
    assert.deepEqual(snap.insights, []);
    assert.deepEqual(snap.brief, { subject: o.brief.subject }, 'only the subject of the brief');
  }
});

test('the exported snapshot keeps everything the embed reads', () => {
  const o = /** @type {any} */ (demo());
  const snap = /** @type {any} */ (exportSnapshot(o));
  assert.equal(snap.name, o.name);
  assert.equal(snap.root, o.root);
  assert.deepEqual(snap.view, o.view);
  assert.deepEqual(snap.edges, o.edges.map((/** @type {any} */ e) => ({ id: e.id, from: e.from, to: e.to, type: e.type, why: e.why })));
  assert.deepEqual(snap.categories, o.categories);
  assert.deepEqual(Object.keys(snap.nodes), Object.keys(o.nodes));
  for (const [id, n] of Object.entries(o.nodes)) {
    const node = /** @type {any} */ (n);
    const s = snap.nodes[id];
    for (const k of ['id', 'label', 'parent', 'category', 'depth', 'summary', 'origin', 'status']) assert.deepEqual(s[k], node[k], `${id}.${k}`);
    assert.deepEqual(s.sources, node.sources);
    if (node.article) {
      for (const k of ['summary', 'keyFacts', 'whyItMatters', 'sources']) assert.deepEqual(s.article[k], node.article[k], `${id}.article.${k}`);
    } else assert.equal(s.article, null);
  }
  const priv = /** @type {any} */ (exportSnapshot(/** @type {any} */ ({ ...o, visibility: 'private' })));
  assert.equal(priv.visibility, 'private');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onto-i4r-'));
const cap = () => ({ out: '', write(/** @type {string} */ s) { this.out += s; return true; } });
/** @param {string} home @param {string[]} args */
async function run(home, args) {
  const stdout = cap(); const stderr = cap();
  const code = await main(args, { home, stdout, stderr, interactive: false, env: { ...process.env, ONTOLOGIZER_HOME: home } });
  return { code, stdout: stdout.out, stderr: stderr.out };
}

test('CLI: json drops the chat unless --include-chat; --include-chat is json only', async () => {
  const home = tmp();
  const events = [...fixtureEvents('plastic-modeling'), { t: 'chat.asked', at: 9e12, chatId: 'main', msgId: 'q1', text: CHAT_MARK }];
  openStore(home).importEvents('plastic-modeling', events);
  assert.equal(openStore(home).read('plastic-modeling').chat.length, 1, 'the planted question is in the map');
  const plain = await run(home, ['export', 'plastic-modeling', '--format', 'json']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout).chat, []);
  assert.ok(!plain.stdout.includes(CHAT_MARK));
  const all = await run(home, ['export', 'plastic-modeling', '--format', 'json', '--include-chat']);
  assert.equal(all.code, 0, all.stderr);
  assert.ok(all.stdout.includes(CHAT_MARK));
  assert.deepEqual(JSON.parse(all.stdout), openStore(home).read('plastic-modeling'));
  const bad = await run(home, ['export', 'demo', '--format', 'context', '--include-chat']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--include-chat only applies to --format json/);
});

test('CLI: a context budget too small for the map is refused with the minimum', async () => {
  const r = await run(tmp(), ['export', 'demo', '--format', 'context', '--budget', '100']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /too small for this map: the smallest context pack it fits in is \d+ tokens/);
  assert.equal(r.stdout, '');
});
