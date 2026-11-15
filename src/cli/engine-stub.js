// @ts-check
// Offline stand-in for Epic C's createEngine: replays fixtures/plastic-modeling.events.jsonl.
import fs from 'node:fs';
import { fuse } from '../core/engine/fuse.js';
import { rosetta } from '../core/engine/rosetta.js';
import { jsonLines } from '../core/engine/jsonl.js';
import { stubOrganize } from './engine-stub-organize.js';
import { stubHydrate } from './engine-stub-hydrate.js';

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
  /** @type {Set<string>} jobs queued and not yet done */ const live = new Set();
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

    /** @param {any} brief @param {{ actor?: any, privateSources?: string[] }} [opts] @returns {Promise<void>} */
    async build(brief, opts) {
      const actor = opts?.actor ?? null; // service mode stamps who asked on every event
      const picked = Array.isArray(opts?.privateSources) ? [...new Set(opts.privateSources)].sort() : [];
      // Service mode wrote ontology.created (and any picked raise) with the draft: start from there.
      const already = Boolean(store.read(id).root);
      const speed = Number(process.env.ONTOLOGIZER_STUB_SPEED) || 1;
      let prev = 0;
      for (const ev of fixtureEvents()) {
        const wait = ((ev.at ?? 0) - prev) / speed;
        if (wait > 0) await sleep(wait);
        prev = ev.at ?? prev;
        if (ev.t === 'ontology.created' && already) continue;
        const e = ev.t === 'ontology.created' ? { ...ev, brief } : ev;
        store.append(id, actor ? { ...e, actor } : e);
        // As the real engine: picked private sources raise the map right after ontology.created.
        if (ev.t === 'ontology.created' && picked.length) {
          const raise = { t: 'visibility.raised', at: ev.at ?? 0, to: 'private', reason: 'sources-picked', sources: picked };
          store.append(id, actor ? { ...raise, actor } : raise);
          if (typeof store.sync === 'function') await store.sync();
        }
      }
    },

    /** @param {{ kind: string, nodeId?: string, nodeIds?: string[] }} job @param {{ actor?: any }} [o] */
    enqueue(job, o = {}) {
      const jobId = `job-${++jobCounter}`;
      /** @type {{ id: string, kind: string, nodeId?: string, nodeIds?: string[] }} */
      const info = { id: jobId, kind: job.kind };
      if (typeof job.nodeId === 'string') info.nodeId = job.nodeId;
      if (Array.isArray(job.nodeIds)) info.nodeIds = [...job.nodeIds];
      const as = (/** @type {any} */ e) => (o?.actor ? { ...e, actor: o.actor } : e);
      const emit = (/** @type {string} */ t, /** @type {any} */ fields) => store.append(id, as({ t, at: store.now(id), ...fields }));
      store.append(id, as({ t: 'job.queued', at: store.now(id), job: info }));
      live.add(jobId);
      setTimeout(async () => {
        try {
          if (job.kind === 'hydrate') await stubHydrate({ store, id, job, emit });
          store.append(id, as({ t: 'job.done', at: store.now(id), job: info }));
        } catch { /* store closed */ } finally { live.delete(jobId); }
      }, 10);
      return jobId;
    },

    /** The ids of jobs queued and not yet done (as the real engine). @returns {Set<string>} */
    activeJobIds: () => new Set(live),

    /** Epic A's offline organise. @param {any} input @param {{ actor?: any }} [o] @returns {Promise<any>} */
    async organize(input, o = {}) {
      const actor = o?.actor ?? null;
      const emit = (/** @type {string} */ t, /** @type {any} */ fields) =>
        store.append(id, { t, at: store.now(id), ...fields, ...(actor ? { actor } : {}) });
      return stubOrganize({ store, id, input, emit, actor });
    },

    /** @param {any} a @param {any} b @param {any} [opts] */
    fuse: (a, b, opts) => /** @type {any} */ (fuse)(ctx, a, b, opts),
    /** @param {any} id2 @param {any} persona @param {any} [opts] */
    rosetta: (id2, persona, opts) => /** @type {any} */ (rosetta)(ctx, id2, persona, opts),
  };
}
