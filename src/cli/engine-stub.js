// @ts-check
// Offline stand-in for Epic C's createEngine: replays fixtures/plastic-modeling.events.jsonl.
import fs from 'node:fs';
import { fuse } from '../core/engine/fuse.js';
import { rosetta } from '../core/engine/rosetta.js';
import { jsonLines } from '../core/engine/jsonl.js';

const FIXTURE = new URL('../../fixtures/plastic-modeling.events.jsonl', import.meta.url);

/** @returns {any[]} */
function fixtureEvents() {
  return fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {{ store: any, id: string, client?: any }} opts */
export function createEngine({ store, id, client: _client = null }) {
  let jobCounter = 0;
  // The stub never calls a model: fuse/rosetta (Epic G's real code) get a client that refuses.
  const refuse = () => { throw new Error('stub engine: no model calls'); };
  const offline = { messages: { stream: refuse, create: refuse } };
  const ctx = { store, models: { fast: '', strong: '' }, getClient: () => offline, jsonLines };
  return {
    /** @param {any} _context @param {any[]} [_answers] */
    check(_context, _answers = []) {
      const created = fixtureEvents().find((e) => e.t === 'ontology.created');
      return { ready: true, brief: created.brief, name: 'plastic-modeling' };
    },

    /** @param {any} brief @param {any} [_opts] @returns {Promise<void>} */
    async build(brief, _opts) {
      const speed = Number(process.env.ONTOLOGIZER_STUB_SPEED) || 1;
      let prev = 0;
      for (const ev of fixtureEvents()) {
        const wait = ((ev.at ?? 0) - prev) / speed;
        if (wait > 0) await sleep(wait);
        prev = ev.at ?? prev;
        store.append(id, ev.t === 'ontology.created' ? { ...ev, brief } : ev);
      }
    },

    /** @param {{ kind: string, nodeId?: string }} job @param {any} [_o] */
    enqueue(job, _o = {}) {
      const jobId = `job-${++jobCounter}`;
      const info = { id: jobId, kind: job.kind, nodeId: job.nodeId };
      store.append(id, { t: 'job.queued', at: store.now(id), job: info });
      setTimeout(() => {
        try { store.append(id, { t: 'job.done', at: store.now(id), job: info }); } catch { /* store closed */ }
      }, 10);
      return jobId;
    },

    /** @param {any} a @param {any} b @param {any} [opts] */
    fuse: (a, b, opts) => /** @type {any} */ (fuse)(ctx, a, b, opts),
    /** @param {any} id2 @param {any} persona @param {any} [opts] */
    rosetta: (id2, persona, opts) => /** @type {any} */ (rosetta)(ctx, id2, persona, opts),
  };
}
