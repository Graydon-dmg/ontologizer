// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll, fold } from '../../src/core/events.js';
import { createExplainRequests, explainStatus } from '../../web/shell/explain.js';
import { menuItems, runMenuItem } from '../../web/shell/menu.js';
import { createSource } from '../../web/shell/source.js';

const events = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const TOOLS = 'plastic-modeling/tools';

/** A fake server: act() records actions and answers like Epic B (202 { ok, jobId }). */
function world(answer = (/** @type {any} */ a) => ({ ok: true, jobId: 'j1' })) {
  let o = foldAll(events);
  /** @type {any[]} */ const acts = [];
  /** @type {string[]} */ const opened = [];
  let t = 0;
  const shell = {
    acts, opened,
    snapshot: () => o,
    apply: (/** @type {any} */ e) => { o = fold(o, e); },
    act: async (/** @type {any} */ a) => { acts.push(a); return answer(a); },
    openExplain: (/** @type {string} */ id) => { opened.push(id); },
    tick: (/** @type {number} */ ms) => { t += ms; },
    /** @type {any} */ explainRequests: null,
    explainNode: (/** @type {string} */ id) => shell.explainRequests.request(id),
  };
  shell.explainRequests = createExplainRequests({ act: shell.act, snapshot: shell.snapshot, now: () => t });
  return shell;
}

/** The panel's "Write an explanation" button does exactly this. @param {any} shell @param {string} id */
const panelButton = (shell, id) => shell.explainNode(id);

/** @param {(shell: any, id: string) => any} press */
async function checkPanelButton(press) {
  const w = world();
  assert.equal(explainStatus(w.snapshot(), TOOLS, w.explainRequests.get(TOOLS)).kind, 'idle');
  await press(w, TOOLS);
  assert.deepEqual(w.acts, [{ type: 'explain', nodeId: TOOLS }]);
  // Until job.queued arrives the panel says it is writing; then the job drives it.
  assert.equal(explainStatus(w.snapshot(), TOOLS, w.explainRequests.get(TOOLS)).kind, 'writing');
}

test('(a) the panel button "Write an explanation" posts { type: explain }', async () => {
  await checkPanelButton(panelButton);
});

test('(a) planted fault: a panel button that only re-renders is caught', async () => {
  await assert.rejects(() => checkPanelButton(async () => {}));
});

/** @param {typeof runMenuItem} run */
async function checkMenuExplain(run) {
  const w = world();
  const item = menuItems(w.snapshot().nodes[TOOLS], w.snapshot()).find((i) => i.id === 'explain');
  assert.ok(item, 'a node without an article offers Explain');
  await run(/** @type {any} */ (item), TOOLS, w);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.acts, [{ type: 'explain', nodeId: TOOLS }]);
  assert.deepEqual(w.opened, [TOOLS]);
}

test('(b) menu Explain on a node without an article posts the action and opens the panel', async () => {
  await checkMenuExplain(runMenuItem);
});

test('(b) planted fault: a menu Explain that only opens the panel is caught', async () => {
  const openOnly = /** @type {any} */ ((/** @type {any} */ item, /** @type {string} */ id, /** @type {any} */ shell) => shell.openExplain(id));
  await assert.rejects(() => checkMenuExplain(openOnly));
});

test('no duplicate: Explain while a job is queued or running only opens the panel', async () => {
  const w = world();
  w.apply({ t: 'job.queued', at: 1, job: { id: 'x1', kind: 'explain', nodeId: TOOLS } });
  const r = await w.explainNode(TOOLS);
  assert.equal(r.sent, false);
  assert.deepEqual(w.acts, []);
  assert.equal(explainStatus(w.snapshot(), TOOLS, undefined).kind, 'writing');
});

test('a failed job shows its error and "Try again" posts again; a node with an article posts nothing', async () => {
  const w = world();
  w.apply({ t: 'job.queued', at: 1, job: { id: 'x1', kind: 'explain', nodeId: TOOLS } });
  w.apply({ t: 'job.failed', at: 2, job: { id: 'x1', kind: 'explain', nodeId: TOOLS, error: 'No Anthropic API key' } });
  const st = explainStatus(w.snapshot(), TOOLS, undefined);
  assert.deepEqual(st, { kind: 'failed', error: 'No Anthropic API key' });
  await w.explainNode(TOOLS);
  assert.equal(w.acts.length, 1);
  w.apply({ t: 'node.updated', at: 3, id: TOOLS, patch: { article: { summary: 's', keyFacts: [], whyItMatters: '', seeAlso: [], sources: [] } } });
  assert.equal((await w.explainNode(TOOLS)).sent, false);
  assert.equal(w.acts.length, 1);
});

test('a refused POST, or an accepted one whose job never arrives, ends as a visible error', async () => {
  const w = world(() => ({ ok: false, error: 'HTTP 500' }));
  await w.explainNode(TOOLS);
  const st = explainStatus(w.snapshot(), TOOLS, w.explainRequests.get(TOOLS));
  assert.equal(st.kind, 'failed');
  assert.match(String(st.error), /HTTP 500/);
  const w2 = world();
  await w2.explainNode(TOOLS);
  w2.tick(9000);
  assert.equal(w2.explainRequests.expire(), true);
  assert.match(String(explainStatus(w2.snapshot(), TOOLS, w2.explainRequests.get(TOOLS)).error), /still running/);
});

test('server mode: a POST to a server that is gone, or that never answers, resolves to { ok: false }', async () => {
  class ES { constructor() { /** @type {any} */ this.onmessage = null; } close() {} }
  const gone = createSource({ search: '', EventSource: ES, fetch: /** @type {any} */ (async () => { throw new TypeError('Failed to fetch'); }) });
  const r1 = await gone.act({ type: 'explain', nodeId: TOOLS });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /still running/);
  const hang = createSource({
    search: '', EventSource: ES, actMs: 20,
    fetch: /** @type {any} */ ((/** @type {string} */ u, /** @type {any} */ init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))),
  });
  const r2 = await hang.act({ type: 'explain', nodeId: TOOLS });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /did not answer/);
  const bad = createSource({ search: '', EventSource: ES, fetch: /** @type {any} */ (async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'nodeId must be a non-empty string' }) })) });
  assert.deepEqual(await bad.act({ type: 'explain', nodeId: '' }), { ok: false, error: 'nodeId must be a non-empty string' });
});
