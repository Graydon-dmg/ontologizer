// @ts-check
// The engine: the context check, the streaming build, and research / explain / sources jobs.
// It writes only events, only through the store.
import Anthropic from '@anthropic-ai/sdk';
import { makeEvent } from '../events.js';
import { jsonLines } from './jsonl.js';
import { runCall } from './call.js';
import { createJobQueue } from './queue.js';
import { check, build } from './build.js';
import { research, explain, sources } from './jobs.js';
import { fuse } from './fuse.js';
import { rosetta } from './rosetta.js';
import { ask } from './chat.js';

export function defaultModels() {
  return {
    fast: process.env.ONTOLOGIZER_FAST_MODEL ?? 'claude-haiku-5-5',
    strong: process.env.ONTOLOGIZER_STRONG_MODEL ?? 'claude-sonnet-5-5',
  };
}

const JOB_KINDS = new Set(['research', 'explain', 'sources']);

/**
 * @param {{ store: { append: (id: string, e: object) => void, read: (id: string) => any, [k: string]: any },
 *           id: string, client?: any, models?: { fast: string, strong: string }, concurrency?: number,
 *           makeClient?: () => any }} opts   makeClient: internal, for tests; defaults to new Anthropic()
 */
export function createEngine({ store, id, client = null, models = defaultModels(), concurrency = 3,
                               makeClient = () => new Anthropic() }) {
  // The default client is created on the first model call, so a missing key never throws here.
  let lazyClient = client;
  const getClient = () => (lazyClient ??= makeClient());

  // `at` is ms since the ontology was created. build() resets the clock when it writes
  // ontology.created; an engine opened on an existing map counts from its own start.
  let startedAt = Date.now();
  /** @param {string} t @param {object} fields */
  const emit = (t, fields) => store.append(id, makeEvent(t, fields, startedAt));

  const queue = createJobQueue({ emit, concurrency });

  /** Shared by build.js and jobs.js. */
  const ectx = {
    store, id, models, getClient, emit, queue,
    /** @param {import('./call.js').CallParams} params @param {(obj: any) => void} onObject */
    call: (params, onObject) => runCall(getClient, params, onObject),
    resetClock: () => { startedAt = Date.now(); },
  };

  const engine = {
    /** @param {string} context @param {any[]} [answers] */
    check: (context, answers = []) => check(ectx, context, answers),

    /** @param {any} brief @param {{ depth?: number }} [opts] */
    build: (brief, { depth = 2 } = {}) => build(ectx, brief, { depth }),

    /**
     * @param {{ kind: 'research', nodeId: string, mode: 'context'|'general' }
     *        | { kind: 'explain', nodeId: string } | { kind: 'sources', nodeId: string }} job
     * @param {{ priority?: number }} [opts]
     * @returns {string} jobId
     */
    enqueue(job, { priority = 0 } = {}) {
      if (!job || !JOB_KINDS.has(job.kind)) throw new Error(`enqueue: unknown job kind ${JSON.stringify(job?.kind)}`);
      if (typeof job.nodeId !== 'string' || !job.nodeId) throw new Error('enqueue: nodeId is required');
      const work = job.kind === 'research'
        ? () => research(ectx, job.nodeId, /** @type {any} */ (job).mode === 'general' ? 'general' : 'context')
        : job.kind === 'explain'
          ? () => explain(ectx, job.nodeId)
          : () => sources(ectx, job.nodeId);
      // Dedupe key includes the mode for research, so "in context" and "general" can run side by side.
      const queued = /** @type {any} */ (job).kind === 'research'
        ? { kind: 'research', nodeId: job.nodeId, dedupeKind: `research-${/** @type {any} */ (job).mode}` }
        : job;
      return queue.add(queued, work, { priority }).jobId;
    },

    /**
     * The chat panel: answer one question about the whole map, streamed. Read-only: it never
     * changes the map or starts a job. Appends chat.asked, then chat.answered or chat.failed.
     * Never throws: a failure is a yielded { type: 'error', error } item.
     * @param {{ chatId?: string, text?: string, images?: import('./chat.js').ChatImage[], lens?: string|null }} input
     * @param {{ signal?: AbortSignal }} [opts]  aborting stops the model call (chat.failed "Stopped.")
     * @returns {AsyncIterable<import('./chat.js').ChatItem>}
     */
    ask: (input, opts) => ask({ store, id, models, getClient, emit }, input, opts),

    /** Resolves when no job is queued or running. */
    idle: () => queue.onIdle(),

    /** @type {(a: string, b: string, opts?: any) => Promise<string>} */
    fuse: (a, b, opts) => fuse(fuseCtx, a, b, opts),
    /** @type {(id: string, persona: string, opts?: any) => Promise<string>} */
    rosetta: (oid, persona, opts) => rosetta(fuseCtx, oid, persona, opts),
  };

  // Epic G's functions get exactly this context.
  const fuseCtx = { store, models, getClient, jsonLines };

  return engine;
}
