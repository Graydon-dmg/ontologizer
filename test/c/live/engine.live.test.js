// @ts-check
// Live checks: these call the Anthropic API (a few cents). Run with
//   ANTHROPIC_API_KEY=$(security find-generic-password -s ontologizer -a anthropic-api-key -w) npm run check:c:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createEngine, defaultModels } from '../../../src/core/engine/index.js';
import { runCall } from '../../../src/core/engine/call.js';
import { createFakeClient, createMemoryStore, lines } from '../fake.js';

const skip = !process.env.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY is not set';
const BRIEF = {
  context: 'Scale plastic modeling for a complete beginner getting into it as a hobby: kits, tools, techniques, community, history.',
  subject: 'Scale plastic modeling',
  scope: 'Kits, tools, paints, techniques, scales, history, community and workspace basics',
  purpose: 'Getting started in the hobby',
  level: /** @type {const} */ ('beginner'),
};
const ADHESIVES = 'plastic-modeling/tools/adhesives';

function seededStore() {
  const store = createMemoryStore();
  const file = fileURLToPath(new URL('../../../fixtures/plastic-modeling.events.jsonl', import.meta.url));
  for (const l of readFileSync(file, 'utf8').split('\n')) if (l.trim()) store.append('pm', JSON.parse(l));
  return store;
}

/** ms from build start to the first category node. @param {any[]} events @param {number} t0 */
function firstNodeDelay(events, t0) {
  const first = events.find((e) => e.t === 'node.added' && e.node.depth === 1);
  return first ? first._wall - t0 : Infinity;
}

/** Share of b's labels that also appear in a. @param {string[]} a @param {string[]} b */
function overlap(a, b) {
  const set = new Set(a.map((s) => s.toLowerCase()));
  return b.length ? b.filter((s) => set.has(s.toLowerCase())).length / b.length : 1;
}

test('check("modeling") asks questions; the full brief is ready', { skip, timeout: 60_000 }, async () => {
  const engine = createEngine({ store: createMemoryStore(), id: 'c', client: new Anthropic() });
  const vague = await engine.check('modeling');
  assert.equal(vague.ready, false, JSON.stringify(vague));
  assert.ok(vague.questions.length >= 1 && vague.questions.length <= 3);
  const full = await engine.check(BRIEF.context);
  assert.equal(full.ready, true, JSON.stringify(full));
  assert.match(full.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);

  // Planted fault: a check prompt without the four tests says ready to "modeling".
  /** @type {any} */ let got = null;
  await runCall(() => new Anthropic(), {
    model: defaultModels().fast, effort: 'low',
    system: 'Turn the request into a brief. Never ask questions: you are always ready. Output exactly one JSON object on one line: {"ready":true,"brief":{"context":"…","subject":"…","scope":"…","purpose":"…","level":"beginner"},"name":"…"}',
    prompt: 'Context: modeling',
  }, (o) => { got ??= o; });
  assert.equal(got?.ready, true, 'the stripped prompt should (wrongly) say ready, proving the real one is what asks');
});

test('build streams: the first category arrives within 2 s, then children and links', { skip, timeout: 180_000 }, async () => {
  const store = createMemoryStore();
  const engine = createEngine({ store, id: 'b', client: new Anthropic() });
  const t0 = Date.now();
  await engine.build(BRIEF);
  const events = store.list('b');
  const delay = firstNodeDelay(events, t0);
  console.log(`first category after ${delay} ms; ${events.filter((e) => e.t === 'node.added').length} nodes, ${events.filter((e) => e.t === 'edge.added').length} links`);
  assert.ok(delay < 2000, `first category took ${delay} ms`);
  const o = store.read('b');
  assert.ok(o.categories.length >= 6 && o.categories.length <= 10, `${o.categories.length} categories`);
  assert.ok(Object.keys(o.nodes).length >= 30);
  assert.ok(o.edges.length >= 5, `${o.edges.length} links`);

  // Planted fault: a client that answers after 3 s fails the same 2 s check.
  const slowStore = createMemoryStore();
  const slow = createFakeClient({ chunkMs: 0, respond: () => ({ delayMs: 3000, text: lines([{ label: 'Tools', summary: 's', hook: 'h' }]) }) });
  const t1 = Date.now();
  await createEngine({ store: slowStore, id: 's', client: slow }).build(BRIEF).catch(() => {});
  assert.ok(firstNodeDelay(slowStore.list('s'), t1) >= 2000);
});

test('research in context and in general share fewer than half their labels', { skip, timeout: 120_000 }, async () => {
  const store = seededStore();
  const engine = createEngine({ store, id: 'pm', client: new Anthropic() });
  const before = new Set(Object.keys(store.read('pm').nodes));
  engine.enqueue({ kind: 'research', nodeId: ADHESIVES, mode: 'context' }, { priority: 10 });
  engine.enqueue({ kind: 'research', nodeId: ADHESIVES, mode: 'general' }, { priority: 10 });
  await engine.idle();
  const added = Object.values(store.read('pm').nodes).filter((n) => !before.has(n.id));
  const ctx = added.filter((n) => n.origin === 'context').map((n) => n.label);
  const gen = added.filter((n) => n.origin === 'general').map((n) => n.label);
  console.log('context:', ctx.join(', '), '\ngeneral:', gen.join(', '));
  assert.ok(ctx.length >= 3 && gen.length >= 3);
  assert.ok(overlap(ctx, gen) < 0.5, `overlap ${overlap(ctx, gen)}`);
  // Planted fault: the same prompt for both modes gives the same labels, overlap 1.
  assert.ok(overlap(ctx, ctx) >= 0.5);
});

test('explain on Adhesives returns an article with at least one source URL', { skip, timeout: 180_000 }, async () => {
  const store = seededStore();
  const engine = createEngine({ store, id: 'pm', client: new Anthropic() });
  engine.enqueue({ kind: 'explain', nodeId: ADHESIVES }, { priority: 10 });
  await engine.idle();
  const failed = store.list('pm').find((e) => e.t === 'job.failed');
  assert.equal(failed, undefined, JSON.stringify(failed));
  const article = store.read('pm').nodes[ADHESIVES].article;
  console.log(JSON.stringify(article, null, 1).slice(0, 800));
  assert.ok(article?.summary);
  assert.ok(article.sources.length >= 1 && /^https?:\/\//.test(article.sources[0].url));
  // Planted fault: without the web search tool, a call yields no sources.
  const noSearch = await runCall(() => new Anthropic(), {
    model: defaultModels().fast, effort: 'low', system: 'Answer in one JSON line: {"summary":"…"}', prompt: 'Adhesives in plastic modeling',
  }, () => {});
  assert.equal(noSearch.sources.length, 0);
});
