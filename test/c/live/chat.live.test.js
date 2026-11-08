// @ts-check
// Live check for engine.ask() (a few cents). Run with
//   ANTHROPIC_API_KEY=$(security find-generic-password -s ontologizer -a anthropic-api-key -w) LIVE=1 node --test test/c/live/chat.live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createEngine } from '../../../src/core/engine/index.js';
import { checkAnswer } from '../../../src/core/engine/chat.js';
import { createMemoryStore } from '../fake.js';

const skip = !process.env.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY is not set';
const ROOT = 'frontier-coding-harnesses';

/** A small hand-built map: what the harnesses are, with no statistics, so numbers must come from the web. */
function harnessMap() {
  const store = createMemoryStore();
  let at = 0;
  /** @param {any} e */ const add = (e) => store.append('h', { at: at++, ...e });
  add({ t: 'ontology.created', name: 'Frontier Coding Harnesses', root: ROOT, categories: [],
    brief: { context: 'Frontier AI coding harnesses: the agent tools that wrap a model to write and change code.',
      subject: 'Frontier AI coding harnesses', scope: 'Harnesses, how they work, and how they are evaluated',
      purpose: 'Choosing and understanding coding agents', level: 'intermediate' } });
  /** @param {string|null} parent @param {string} slug @param {string} label @param {string} summary */
  const node = (parent, slug, label, summary) => {
    const id = parent ? `${parent}/${slug}` : slug;
    const depth = id.split('/').length - 1;
    const category = depth === 0 ? '' : id.split('/').slice(0, 2).join('/');
    add({ t: 'node.added', node: { id, label, parent, category, depth, summary, hook: '', origin: depth ? 'context' : 'seed',
      sources: [], article: null, status: 'done', createdBy: 'wave1' } });
    return id;
  };
  node(null, ROOT, 'Frontier Coding Harnesses', 'Agent programs that wrap a language model with tools to read, edit, run and test code.');
  const h = node(ROOT, 'harnesses', 'Harnesses', 'The leading coding agents and the products around them.');
  node(h, 'claude-code', 'Claude Code', "Anthropic's terminal coding agent: reads the repo, edits files, runs commands and tests in a loop.");
  node(h, 'codex', 'OpenAI Codex', "OpenAI's coding agent, as a CLI and a cloud service that works on tasks in sandboxes.");
  node(h, 'cursor', 'Cursor Agent', 'An AI-first code editor whose agent mode plans and makes multi-file changes.');
  node(h, 'aider', 'Aider', 'An open-source terminal pair programmer that edits files in a git repo and commits each change.');
  node(h, 'openhands', 'OpenHands', 'An open-source agent platform that writes code, runs commands and browses in a sandbox.');
  const b = node(ROOT, 'benchmarks', 'Benchmarks', 'Test suites that measure how well agents solve real programming tasks.');
  node(b, 'swe-bench-verified', 'SWE-bench Verified', 'Human-checked GitHub issues from Python repos; an agent must produce a patch that passes the tests.');
  node(b, 'terminal-bench', 'Terminal-Bench', 'Tasks done entirely in a terminal, from compiling code to configuring servers.');
  const t = node(ROOT, 'techniques', 'Techniques', 'How harnesses turn a model into a reliable engineer.');
  node(t, 'tool-loop', 'Tool Loop', 'The model calls tools (read, edit, run), sees results, and repeats until the task is done.');
  node(t, 'context-management', 'Context Management', 'Choosing what code and history fit in the model\'s context window, and compacting the rest.');
  node(t, 'subagents', 'Subagents', 'Spawning helper agents for side tasks so the main agent keeps a clean context.');
  return store;
}

test('ask on the coding-harness map cites map nodes and gives web statistics with links', { skip, timeout: 240_000 }, async () => {
  const store = harnessMap();
  const engine = createEngine({ store, id: 'h', client: new Anthropic() });
  const items = [];
  const t0 = Date.now();
  let first = 0;
  for await (const item of engine.ask({ text: "give me some examples of the world's best coding harnesses and statistics to show how effective they are" })) {
    if (item.type === 'delta' && !first) first = Date.now() - t0;
    items.push(item);
  }
  const answered = store.list('h').find((e) => e.t === 'chat.answered');
  const failed = store.list('h').find((e) => e.t === 'chat.failed');
  assert.equal(failed, undefined, JSON.stringify(failed));
  console.log(`first text after ${first} ms, total ${Date.now() - t0} ms`);
  console.log(answered.text);
  console.log('citations:', answered.citations.map((/** @type {any} */ c) => c.nodeId).join(', '));
  console.log('sources:', answered.sources.length, 'suggestions:', JSON.stringify(answered.suggestions));
  console.log('status:', items.filter((i) => i.type === 'status').map((i) => i.text).join(' | '));

  const nodes = store.read('h').nodes;
  assert.ok(answered.citations.length >= 2, 'cites map nodes');
  for (const c of answered.citations) assert.ok(nodes[c.nodeId], `cited ${c.nodeId}`);
  assert.equal(answered.usedWeb, true);
  assert.ok(answered.sources.length >= 1, 'has web sources');
  assert.match(answered.text, /\d+(\.\d+)?\s*%/, 'gives a statistic');
  assert.deepEqual(checkAnswer(answered.text, { nodes }), [], 'format check');
  assert.equal(items.at(-1).type, 'done');

  // Planted fault: the same answer with its links stripped fails the format check.
  const stripped = answered.text.replace(/\(?\[([^\]]+)\]\((https?:[^)]+)\)\)?/g, '$1').replace(/https?:\/\/\S+/g, '');
  assert.ok(checkAnswer(stripped).length >= 1, 'stripping the links must fail the check');
});
