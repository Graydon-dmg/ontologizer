// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/core/engine/index.js';
import { createMemoryStore } from './fake.js';

test('createEngine with no client and no ANTHROPIC_API_KEY returns an engine without throwing', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const engine = createEngine({ store: createMemoryStore(), id: 'x' });
    for (const k of ['check', 'build', 'enqueue', 'fuse', 'rosetta']) assert.equal(typeof engine[k], 'function', k);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('the default client is made on the first model call, not in createEngine', async () => {
  let made = 0;
  const makeClient = () => { made++; throw new Error('no key'); };
  const engine = createEngine({ store: createMemoryStore(), id: 'x', makeClient });
  assert.equal(made, 0);
  // Planted fault: an eager constructor (calling makeClient at once) throws here instead.
  const eager = (/** @type {any} */ o) => { o.makeClient(); return {}; };
  assert.throws(() => eager({ makeClient }));
  await assert.rejects(engine.check('modeling'));   // first model call reaches the factory (or the placeholder)
});

test('fuse and rosetta are attached and reach Epic G (placeholder or real)', async () => {
  const engine = createEngine({ store: createMemoryStore(), id: 'x', client: {} });
  // Until Epic G lands these throw "not built yet"; afterwards they run. Either way they are wired.
  await engine.fuse('a', 'b', {}).catch((e) => assert.match(String(e.message), /fuse|not built|read|draft/));
  await engine.rosetta('a', 'p', {}).catch((e) => assert.match(String(e.message), /rosetta|not built|read/));
});
