// @ts-check
// S3: the two new fold cases (mode on ontology.created, node.hydrated). Each check feeds its planted
// fault first, so a check that cannot fail is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fold, foldAll, emptyOntology } from '../../src/core/events.js';

const FIXTURES = ['demo', 'manga', 'plastic-modeling'];
/** @param {string} name */
const events = (name) => readFileSync(new URL(`../../fixtures/${name}.events.jsonl`, import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** @param {string} name */
const golden = (name) => readFileSync(new URL(`./golden/${name}.fold.json`, import.meta.url), 'utf8');

const H = { job: 'Lending protocols', examples: ['a', 'b', 'c'], not_for: 'Not DEXes', not_for_ids: ['dex'],
  model: 'sonnet', at: '2026-11-15T00:00:00.000Z' };
const created = { t: 'ontology.created', at: 0, name: 'M', root: 'r', brief: { context: '' }, categories: [] };
const base = () => foldAll([created, { t: 'node.added', at: 1, node: { id: 'r', label: 'R', parent: null } },
  { t: 'node.added', at: 2, node: { id: 'defi', label: 'DeFi', parent: 'r' } }]);

test('folds of the three fixtures are byte-identical to 1.8.0 (no mode key when none is given)', () => {
  // planted fault: an emptyOntology() that defaults mode: 'human' changes the string
  const faulty = (/** @type {any[]} */ ev) => { let o = { ...emptyOntology(), mode: 'human' }; for (const e of ev) o = fold(o, e); return o; };
  assert.notEqual(JSON.stringify(faulty(events('demo'))), golden('demo'));
  for (const f of FIXTURES) assert.equal(JSON.stringify(foldAll(events(f))), golden(f), f);
});

test('ontology.created sets mode only to agent or human', () => {
  assert.equal(foldAll([{ ...created, mode: 'agent' }]).mode, 'agent');
  assert.equal(foldAll([{ ...created, mode: 'human' }]).mode, 'human');
  for (const mode of [undefined, null, 'robot', 1]) assert.ok(!('mode' in foldAll([{ ...created, mode }])), String(mode));
});

test('node.hydrated folds a deep copy onto an existing node', () => {
  const e = { t: 'node.hydrated', at: 3, nodeId: 'defi', hydration: structuredClone(H) };
  const o = fold(base(), e);
  assert.deepEqual(o.nodes.defi.hydration, H);
  assert.equal(o.nodes.defi.label, 'DeFi');
  e.hydration.examples.push('mutated');
  e.hydration.not_for_ids.push('mutated');
  assert.deepEqual(o.nodes.defi.hydration, H, 'folded arrays must be copies of the event arrays');
  // planted fault: a fold that stores the event's own object sees the mutation
  const leaky = { ...H, examples: e.hydration.examples };
  assert.notDeepEqual(leaky, H);
});

test('node.hydrated for an unknown node, or a malformed one, is ignored and never throws', () => {
  const o = base();
  const bad = [
    { nodeId: 'nope', hydration: H },
    { nodeId: 'constructor', hydration: H },
    { nodeId: '__proto__', hydration: H },
    { nodeId: 'defi', hydration: { ...H, examples: 'x' } },
    { nodeId: 'defi', hydration: { ...H, not_for_ids: [1] } },
    { nodeId: 'defi', hydration: { ...H, job: 3 } },
    { nodeId: 'defi', hydration: { ...H, at: undefined } },
    { nodeId: 'defi', hydration: null },
    { nodeId: 'defi', hydration: 'x' },
    { nodeId: 7, hydration: H },
    {},
  ];
  for (const b of bad) {
    const after = fold(o, { t: 'node.hydrated', at: 4, ...b });
    assert.equal(after, o, JSON.stringify(b));
  }
  // the map still loads after a malformed event, and a later good one still applies
  const all = foldAll([created, { t: 'node.added', at: 1, node: { id: 'defi', label: 'DeFi', parent: null } },
    { t: 'node.hydrated', at: 2, nodeId: 'defi', hydration: { ...H, examples: 'x' } },
    { t: 'node.hydrated', at: 3, nodeId: 'defi', hydration: H }]);
  assert.deepEqual(all.nodes.defi.hydration, H);
  // planted fault: a fold that spreads a non-array throws
  assert.throws(() => [...(/** @type {any} */ (5))]);
});

test('a node without hydration has no hydration key', () => {
  assert.ok(!('hydration' in base().nodes.defi));
});
