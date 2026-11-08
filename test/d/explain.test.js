// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';
import { explainModel } from '../../web/shell/explain.js';

const events = readFileSync(new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ids = events.filter((e) => e.t === 'node.added').map((e) => e.node.id);
const [a, b] = [ids[1], ids[2]];
const job = (t, state) => ({ t, at: 5, job: { id: 'j1', kind: 'explain', nodeId: a } });

const ignoresLens = (o, id) => {
  const m = explainModel(o, id);
  const lens = Object.values(o.lenses)[0];
  return { ...m, analog: lens && lens.analogs[id] ? { lensId: lens.id, persona: lens.persona, ...lens.analogs[id] } : null };
};
const ignoresJobs = (o, id) => ({ ...explainModel(o, id), researching: false });

function checkResearching(model) {
  assert.equal(model(foldAll(events), a).researching, false);
  assert.equal(model(foldAll([...events, job('job.queued')]), a).researching, true);
  assert.equal(model(foldAll([...events, job('job.queued'), job('job.started')]), a).researching, true);
  assert.equal(model(foldAll([...events, job('job.queued'), job('job.done')]), a).researching, false);
}

const lensEvents = [
  { t: 'lens.added', at: 6, lens: { id: 'cook', persona: 'a cook', analogs: {} } },
  { t: 'lens.analog', at: 7, lensId: 'cook', nodeId: a, label: 'Mise en place', breaks: 'plastic does not burn' },
  { t: 'view.changed', at: 8, patch: { lens: 'cook' } },
];
function checkAnalog(model) {
  const on = model(foldAll([...events, ...lensEvents]), a);
  assert.equal(on.analog.label, 'Mise en place');
  assert.equal(on.analog.breaks, 'plastic does not burn');
  assert.equal(on.analog.persona, 'a cook');
  assert.equal(model(foldAll([...events, ...lensEvents]), b).analog, null);
  const off = model(foldAll([...events, ...lensEvents, { t: 'view.changed', at: 9, patch: { lens: null } }]), a);
  assert.equal(off.analog, null);
}

test('researching is true while the explain job is queued or running', () => {
  checkResearching(explainModel);
  assert.throws(() => checkResearching(ignoresJobs));
});

test('analog and breaks show when a lens is active and vanish when it is cleared', () => {
  checkAnalog(explainModel);
  assert.throws(() => checkAnalog(ignoresLens));
});

test('seeAlso resolves ids and labels and skips unknown ones', () => {
  const o = foldAll([...events, { t: 'node.updated', at: 3, id: a, patch: { article: {
    summary: 's', keyFacts: [], whyItMatters: '', sources: [{ title: 't', url: 'https://x.test' }],
    seeAlso: [b, foldAll(events).nodes[ids[3]].label, 'nope/zzz'] } } }]);
  const m = explainModel(o, a);
  assert.deepEqual(m.seeAlso.map((s) => s.id), [b, ids[3]]);
  assert.equal(m.sources.length, 1);
});
