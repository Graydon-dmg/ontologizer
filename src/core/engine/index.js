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
import { createRun } from './run.js';

export function defaultModels() {
  return {
    fast: process.env.ONTOLOGIZER_FAST_MODEL ?? 'claude-haiku-5-5',
    strong: process.env.ONTOLOGIZER_STRONG_MODEL ?? 'claude-sonnet-5-5',
  };
}

const JOB_KINDS = new Set(['research', 'explain', 'sources']);

/**
 * Per-run options (service mode; the CLI passes none and writes exactly what it always did):
 * - actor: stamped on every event the run appends, as a top-level `actor` field.
 * - principal: who asked; passed to the model port with the call's purpose.
 * - tools: a ToolSet of configured sources (src/server/sources.js), or null.
 * - privateSources (build only): private sources picked in New map; the map is raised to private
 *   (reason 'sources-picked') right after ontology.created, before anything else is written (skipped
 *   when the map already has its ontology.created: service mode writes both with the draft).
 * - picked (build only): every source picked in New map; the build's prompts say they are the
 *   reader's chosen references, to be searched for each category.
 * @typedef {{ actor?: any, principal?: any, tools?: import('./run.js').ToolSet|null, privateSources?: string[], picked?: string[] }} RunOpts
 * @typedef {'check'|'build'|'research'|'explain'|'sources'|'ask'|'fuse'|'rosetta'} Purpose
 */

/**
 * @param {{ store: { append: (id: string, e: object) => void, read: (id: string) => any, [k: string]: any },
 *           id: string, client?: any, models?: { fast: string, strong: string }, concurrency?: number,
 *           makeClient?: () => any, clientFor?: ((o: { principal: any, purpose: Purpose }) => any) | null }} opts
 *   makeClient: internal, for tests; defaults to new Anthropic().
 *   clientFor: the model port. Called for each model call with its principal and purpose; without it
 *   every call uses the one default client.
 */
export function createEngine({ store, id, client = null, models = defaultModels(), concurrency = 3,
                               makeClient = () => new Anthropic(), clientFor = null }) {
  // The default client is created on the first model call, so a missing key never throws here.
  let lazyClient = client;
  /** @param {Purpose} [purpose] @param {any} [principal] */
  const getClient = (purpose = 'build', principal = null) =>
    (clientFor ? clientFor({ principal, purpose }) : (lazyClient ??= makeClient()));

  /** Resolves when every write so far is stored: a Postgres store's sync(); the file store has none (its appends are synchronous). */
  const durable = async () => { if (typeof store.sync === 'function') await store.sync(); };

  // `at` is ms since the ontology was created. build() resets the clock when it writes
  // ontology.created; an engine opened on an existing map counts from its own start.
  let startedAt = Date.now();
  /** @param {string} t @param {object} fields */
  const emit = (t, fields) => store.append(id, makeEvent(t, fields, startedAt));

  const queue = createJobQueue({ emit, concurrency });

  /**
   * The context build.js and jobs.js get for one run: its emit stamps the actor, its calls go to the
   * model port with this purpose, and `{ useTools: true }` on a call offers the run's source tools.
   * @param {Purpose} purpose @param {RunOpts} [o]
   */
  function runCtx(purpose, { actor = null, principal = null, tools = null, privateSources = [], picked = [] } = {}) {
    /** @param {string} t @param {object} fields */
    const emitAs = actor ? (t, fields) => emit(t, { ...fields, actor }) : emit;
    const run = createRun({ tools, emit: emitAs, read: () => store.read(id), durable });
    return {
      store, id, models, queue, actor, run, durable,
      picked: Array.isArray(privateSources) ? privateSources.filter((n) => typeof n === 'string' && n) : [],
      chosen: Array.isArray(picked) ? picked.filter((n) => typeof n === 'string' && n) : [],
      getClient: () => getClient(purpose, principal),
      emit: emitAs,
      /** @param {any} params @param {(obj: any) => void} onObject */
      call: (params, onObject) => {
        const { useTools, ...p } = params;
        // Every call knows whether the map is private now (a private map's run gets no web search).
        return runCall(() => getClient(purpose, principal), { ...p, tools: useTools ? run.tools : null, restricted: run.restricted }, onObject);
      },
      /** The verified source refs of a model line's `sources`. @param {any} list */
      cite: (list) => run.cite(list),
      resetClock: () => { startedAt = Date.now(); },
    };
  }

  const engine = {
    /** @param {string} context @param {any[]} [answers] @param {{ principal?: any }} [opts] */
    check: (context, answers = [], opts = {}) => check(runCtx('check', { principal: opts?.principal }), context, answers),

    /** @param {any} brief @param {{ depth?: number } & RunOpts} [opts] */
    build: (brief, { depth = 2, ...o } = {}) => build(runCtx('build', o), brief, { depth }),

    /**
     * @param {{ kind: 'research', nodeId: string, mode: 'context'|'general' }
     *        | { kind: 'explain', nodeId: string } | { kind: 'sources', nodeId: string }} job
     * @param {{ priority?: number } & RunOpts} [opts]  the sources job never gets tools
     * @returns {string} jobId
     */
    enqueue(job, { priority = 0, ...o } = {}) {
      if (!job || !JOB_KINDS.has(job.kind)) throw new Error(`enqueue: unknown job kind ${JSON.stringify(job?.kind)}`);
      if (typeof job.nodeId !== 'string' || !job.nodeId) throw new Error('enqueue: nodeId is required');
      const ctx = runCtx(job.kind, job.kind === 'sources' ? { ...o, tools: null } : o);
      const work = job.kind === 'research'
        ? () => research(ctx, job.nodeId, /** @type {any} */ (job).mode === 'general' ? 'general' : 'context')
        : job.kind === 'explain'
          ? () => explain(ctx, job.nodeId)
          : () => sources(ctx, job.nodeId);
      // Dedupe key includes the mode for research, so "in context" and "general" can run side by side.
      const queued = /** @type {any} */ (job).kind === 'research'
        ? { kind: 'research', nodeId: job.nodeId, dedupeKind: `research-${/** @type {any} */ (job).mode}` }
        : job;
      return queue.add(queued, work, { priority, actor: ctx.actor }).jobId;
    },

    /**
     * The chat panel: answer one question about the whole map, streamed. Read-only: it never
     * changes the map or starts a job. Appends chat.asked, then chat.answered or chat.failed.
     * Never throws: a failure is a yielded { type: 'error', error } item.
     * @param {{ chatId?: string, text?: string, images?: import('./chat.js').ChatImage[], lens?: string|null }} input
     * @param {{ signal?: AbortSignal } & RunOpts} [opts]  aborting stops the model call (chat.failed "Stopped.")
     * @returns {AsyncIterable<import('./chat.js').ChatItem>}
     */
    ask: (input, { signal, ...o } = {}) => {
      const c = runCtx('ask', o);
      return ask({ store, id, models, getClient: c.getClient, emit: c.emit, run: c.run, durable }, input, signal ? { signal } : {});
    },

    /** Resolves when no job is queued or running. */
    idle: () => queue.onIdle(),

    /** @type {(a: string, b: string, opts?: any) => Promise<string>} */
    fuse: (a, b, opts) => fuse(gctx('fuse', opts), a, b, opts),
    /** @type {(id: string, persona: string, opts?: any) => Promise<string>} */
    rosetta: (oid, persona, opts) => rosetta(gctx('rosetta', opts), oid, persona, opts),
  };

  // Epic G's functions get exactly this context (getClient goes through the model port).
  /** @param {Purpose} purpose @param {any} opts */
  const gctx = (purpose, opts) => ({ store, models, getClient: () => getClient(purpose, opts?.principal ?? null), jsonLines });

  return engine;
}
