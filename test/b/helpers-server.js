// @ts-check
import { foldAll, fold, emptyOntology } from '../../src/core/events.js';

/** In-memory store with exactly the interface the server uses. @param {any[]} [initial] */
export function fakeStore(initial = []) {
  /** @type {any[]} */
  const log = [...initial];
  /** @type {Set<Function>} */
  const subs = new Set();
  /** @type {Record<string, any>} */
  const sessionMap = {};
  let clock = 1000;
  return {
    log,
    sessionMap,
    read: () => (log.length ? foldAll(log) : emptyOntology()),
    async *events(_id, { from = 0 } = {}) {
      const snap = log.slice(from);
      for (const e of snap) yield e;
    },
    subscribe(_id, /** @type {Function} */ fn) { subs.add(fn); return () => subs.delete(fn); },
    append(_id, /** @type {any} */ e) {
      log.push(e);
      const idx = log.length - 1;
      for (const f of [...subs]) f(e, idx);
    },
    now: () => clock++,
    sessions: {
      set: (/** @type {string} */ id, /** @type {any} */ v) => { sessionMap[id] = v; },
      remove: (/** @type {string} */ id) => { delete sessionMap[id]; },
    },
    subscriberCount: () => subs.size,
  };
}

export { fold };

/** @returns {{ calls: any[], enqueue: (job: any, opts: any) => string }} */
export function fakeEngine() {
  /** @type {any[]} */
  const calls = [];
  return { calls, enqueue(job, opts) { calls.push({ job, opts }); return `job-${calls.length}`; } };
}
