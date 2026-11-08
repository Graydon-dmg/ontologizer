// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import {
  chatBody, postChat, parseInline, citationIds, acceptImages, createSSEParser, applyChatItem, emptyAnswer,
  chatThread, pendingQuestion, starterQuestions, scaleSize, pickEncoding, suggestionAction, answerCitations, researchBusy } from '../../web/shell/chat.js';
import { renderMarkdown } from '../../web/shell/chat-render.js';

const ev = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const onto = foldAll(ev);
const CEMENT = 'plastic-modeling/tools/adhesives/plastic-cement';

// ---------- sending posts the right body
/** @param {typeof chatBody} body */
async function checkSend(body) {
  /** @type {any[]} */ const calls = [];
  const fakeFetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    const text = 'data: {"type":"status","text":"Searching your map…"}\n\ndata: {"type":"delta","text":"Use [[' + CEMENT + ']]."}\n\ndata: {"type":"done","msgId":"a1"}\n\n';
    return { ok: true, status: 200, body: null, text: async () => text };
  });
  const b = body('  how do I glue clear parts?  ', [{ mime: 'image/png', data: 'AAAA' }], 'cook');
  /** @type {any[]} */ const items = [];
  const r = await postChat(fakeFetch, /** @type {any} */ (b), (it) => items.push(it));
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, '/api/chat');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'how do I glue clear parts?', images: [{ mime: 'image/png', data: 'AAAA' }], lens: 'cook' });
  assert.deepEqual(items.map((i) => i.type), ['status', 'delta', 'done']);
  assert.equal(body('   ', []), null, 'nothing to send posts nothing');
}

test('sending posts { text, images, lens } to /api/chat and streams the answer items', async () => {
  await checkSend(chatBody);
});

test('planted fault: a send that drops the images is caught', async () => {
  const noImages = /** @type {typeof chatBody} */ ((t, imgs, lens) => { const b = chatBody(t, [], lens); return b; });
  await assert.rejects(() => checkSend(noImages));
});

test('errors before the stream show a clear message (409, 400, server gone)', async () => {
  const f409 = /** @type {any} */ (async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'A chat answer is already being written for this map; wait for it to finish.' }) }));
  const r1 = await postChat(f409, { text: 'x' }, () => {});
  assert.deepEqual([r1.ok, r1.status], [false, 409]);
  assert.match(String(r1.error), /wait for it to finish/);
  const gone = /** @type {any} */ (async () => { throw new TypeError('Failed to fetch'); });
  assert.match(String((await postChat(gone, { text: 'x' }, () => {})).error), /still running/);
});

// ---------- [[id]] becomes a chip; model text never becomes markup
class FakeNode {
  /** @param {string} tag */
  constructor(tag) { this.tag = tag; /** @type {any[]} */ this.children = []; this.attrs = /** @type {Record<string,string>} */ ({}); this.className = ''; this._text = ''; /** @type {Record<string, Function>} */ this.on = {}; }
  appendChild(/** @type {any} */ c) { this.children.push(c); return c; }
  setAttribute(/** @type {string} */ k, /** @type {string} */ v) { this.attrs[k] = v; }
  addEventListener(/** @type {string} */ t, /** @type {Function} */ f) { this.on[t] = f; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_v) { throw new Error('innerHTML must never be used for model text'); }
}
const fakeDoc = {
  createElement: (/** @type {string} */ t) => new FakeNode(t),
  createTextNode: (/** @type {string} */ s) => ({ tag: '#text', textContent: s, children: [] }),
};
/** @param {any} n @param {(n: any) => boolean} pred @returns {any[]} */
const find = (n, pred) => [...(pred(n) ? [n] : []), ...(n.children || []).flatMap((/** @type {any} */ c) => find(c, pred))];

/** @param {typeof parseInline} parse */
function checkChip(parse) {
  const inl = parse(`Glue it with [[${CEMENT}]] or [[no/such/node]].`);
  assert.ok(inl.some((x) => x.t === 'cite' && x.id === CEMENT));
  /** @type {string[]} */ const cited = [];
  const root = renderMarkdown(fakeDoc, `Glue it with [[${CEMENT}]] or [[no/such/node]].`, { ontology: onto, onCite: (id) => cited.push(id) });
  const chips = find(root, (n) => n.className === 'cite');
  assert.equal(chips.length, 1, 'only existing nodes become chips');
  assert.equal(chips[0].textContent, 'Plastic cement');
  assert.equal(chips[0].attrs['data-node'], CEMENT);
  chips[0].on.click();
  assert.deepEqual(cited, [CEMENT]);
}

test('[[node-id]] in an answer becomes a chip with the node label; clicking it cites that node', () => {
  checkChip(parseInline);
});

test('planted fault: a parser that leaves [[id]] as plain text is caught', () => {
  const literal = /** @type {typeof parseInline} */ ((s) => [{ t: 'text', v: s }]);
  assert.throws(() => checkChip(literal));
});

/** @param {typeof renderMarkdown} render */
function checkScript(render) {
  const evil = 'Hi <script>alert(1)</script> and <img src=x onerror=alert(2)> [x](javascript:alert(3)) **bold**';
  const root = render(fakeDoc, evil, { ontology: onto });
  assert.equal(find(root, (n) => n.tag === 'script' || n.tag === 'img').length, 0, 'no element from model text');
  assert.ok(root.textContent.includes('<script>alert(1)</script>'), 'the markup shows as text');
  assert.equal(find(root, (n) => n.tag === 'a').length, 0, 'javascript: links are not links');
  assert.equal(find(root, (n) => n.tag === 'strong').length, 1, 'light markdown still works');
}

test('model text with <script> renders as text (no markup, no javascript: links)', () => {
  checkScript(renderMarkdown);
});

test('planted fault: a renderer that uses innerHTML is caught', () => {
  const html = /** @type {typeof renderMarkdown} */ ((doc, text) => { const d = doc.createElement('div'); d.innerHTML = text; return d; });
  assert.throws(() => checkScript(html));
});

// ---------- paste adds an image
/** @param {typeof acceptImages} accept */
function checkPaste(accept) {
  // A clipboard image has a type but often no name.
  const pasted = [{ type: 'image/png', name: '' }];
  assert.deepEqual(accept(0, pasted).accepted, pasted);
  const mixed = accept(3, [{ type: 'image/jpeg' }, { type: 'image/webp' }, { type: 'application/pdf' }]);
  assert.equal(mixed.accepted.length, 1, 'at most 4 in total');
  assert.match(mixed.error, /Up to 4 images/);
  assert.match(mixed.error, /Only images/);
}

test('paste (or drop) adds an image; at most 4; non-images are refused with a clear message', () => {
  checkPaste(acceptImages);
});

test('planted fault: an image picker that needs a file name (so paste fails) is caught', () => {
  const needsName = /** @type {typeof acceptImages} */ ((have, files) => acceptImages(have, files.filter((f) => f.name)));
  assert.throws(() => checkPaste(needsName));
});

// ---------- stream, thread, starters, images
test('the stream parser and the live answer follow B and C: delta, citation, source, suggestion, status, done.msgId, error', () => {
  const p = createSSEParser();
  const a = p.push('data: {"type":"delta","text":"Hel');
  const b = p.push('lo"}\n\n: ping\n\ndata: {"type":"source","title":"Tamiya","url":"https://tamiya.com/x"}\n\ndata: {"type":"source","url":"javascript:alert(1)"}\n\n');
  const c = p.push('data: {"type":"suggestion","kind":"research","nodeId":"' + CEMENT + '","mode":"general","label":"Plastic cement"}\n\ndata: {"type":"done","msgId":"m9"}\n\n');
  let s = emptyAnswer();
  for (const it of [...a, ...b, ...c]) s = applyChatItem(s, it);
  assert.equal(s.text, 'Hello');
  assert.deepEqual(s.sources, [{ title: 'Tamiya', url: 'https://tamiya.com/x' }], 'unsafe links dropped');
  assert.deepEqual(suggestionAction(s.suggestions[0]), { type: 'research', nodeId: CEMENT, mode: 'general' });
  assert.deepEqual([s.done, s.id], [true, 'm9']);
  assert.equal(applyChatItem(emptyAnswer(), { type: 'error', error: 'No Anthropic API key' }).error, 'No Anthropic API key');
});

test('history from ontology.chat pairs each question with its reply; the pending one is found', () => {
  const o = foldAll([...ev,
    { t: 'chat.asked', at: 1, chatId: 'main', msgId: 'u1', text: 'q1', images: [{ hash: 'abc', mime: 'image/png', w: 10, h: 10 }] },
    { t: 'chat.answered', at: 2, chatId: 'main', msgId: 'a1', replyTo: 'u1', text: `See [[${CEMENT}]]`, citations: [{ nodeId: CEMENT, label: 'Plastic cement' }], sources: [], suggestions: [], usedWeb: false },
    { t: 'chat.asked', at: 3, chatId: 'main', msgId: 'u2', text: 'q2', images: [] },
  ]);
  const t = chatThread(o);
  assert.deepEqual(t.map((x) => [x.question.msgId, x.reply && x.reply.msgId]), [['u1', 'a1'], ['u2', null]]);
  assert.equal(pendingQuestion(o).msgId, 'u2');
  assert.deepEqual(answerCitations(o, t[0].reply), [CEMENT]);
});

test('three starter questions come from the map categories', () => {
  const q = starterQuestions(onto);
  assert.equal(q.length, 3);
  assert.match(q[1], /How does Kits relate to Tools\?/);
});

test('images are downscaled to 1568 px on the long edge and re-encoded (PNG for screenshots, JPEG for photos)', () => {
  assert.deepEqual(scaleSize(4032, 3024), { w: 1568, h: 1176 });
  assert.deepEqual(scaleSize(800, 600), { w: 800, h: 600 });
  assert.equal(pickEncoding('image/png').mime, 'image/png');
  assert.deepEqual(pickEncoding('image/jpeg'), { mime: 'image/jpeg', quality: 0.85 });
});

test('researchBusy: a Research suggestion stays disabled while its job is queued or running', () => {
  // Build the map the way the page does: fold real job events (job.state is set by events.js).
  const job = (kind, nodeId) => ({ id: 'j1', kind, nodeId });
  const after = (/** @type {string[]} */ ts, kind = 'research', nodeId = 'm/a') =>
    foldAll(ts.map((t, i) => ({ t, at: i, job: job(kind, nodeId) })));
  assert.equal(researchBusy(after(['job.queued']), 'm/a'), true);
  assert.equal(researchBusy(after(['job.queued', 'job.started']), 'm/a'), true);
  // planted faults: a finished job, another node, or another kind of job must not disable it
  assert.equal(researchBusy(after(['job.queued', 'job.started', 'job.done']), 'm/a'), false);
  assert.equal(researchBusy(after(['job.queued', 'job.started', 'job.failed']), 'm/a'), false);
  assert.equal(researchBusy(after(['job.started'], 'research', 'm/b'), 'm/a'), false);
  assert.equal(researchBusy(after(['job.started'], 'explain'), 'm/a'), false);
  assert.equal(researchBusy({}, 'm/a'), false);
});
