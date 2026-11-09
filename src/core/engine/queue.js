// @ts-check
// One small priority queue for every model call that is a job: build wave 1 (priority 0) and
// clicked research / explain / sources (priority 10). Emits job.queued / started / done / failed.
import PQueue from 'p-queue';
import { jobErrorMessage } from './call.js';

/**
 * @typedef {{ kind: string, nodeId?: string, [k: string]: any }} Job
 * @typedef {{ ok: true } | { ok: false, error: any }} JobOutcome
 */

/**
 * @param {{ emit: (t: string, fields: object) => void, concurrency?: number }} opts
 */
export function createJobQueue({ emit, concurrency = 3 }) {
  const queue = new PQueue({ concurrency });
  /** @type {Map<string, { jobId: string, done: Promise<JobOutcome> }>} */
  const active = new Map();   // kind:nodeId -> the queued or running job
  let counter = 0;
  const stamp = Date.now().toString(36);

  /**
   * Queue one job. The same kind on the same node is never queued twice while one is queued or
   * running: the second call gets the first job's id back.
   * @param {Job} job
   * @param {() => Promise<void>} work   does the job; throws to fail it
   * @param {{ priority?: number, actor?: any }} [opts]  actor: stamped on this job's events (service mode)
   * @returns {{ jobId: string, done: Promise<JobOutcome>, duplicate: boolean }}
   */
  function add(job, work, { priority = 0, actor = null } = {}) {
    const key = `${job.dedupeKind ?? job.kind}:${job.nodeId ?? ''}`;
    const existing = active.get(key);
    if (existing) return { ...existing, duplicate: true };

    const jobId = `${job.kind}-${stamp}-${++counter}`;
    /** @type {{ id: string, kind: string, nodeId?: string }} */
    const ref = { id: jobId, kind: job.kind };
    if (job.nodeId) ref.nodeId = job.nodeId;

    /** @param {Record<string, any>} fields */
    const as = (fields) => (actor ? { ...fields, actor } : fields);
    emit('job.queued', as({ job: ref }));
    /** @type {Promise<JobOutcome>} */
    const done = queue.add(async () => {
      emit('job.started', as({ job: ref }));
      try {
        await work();
        emit('job.done', as({ job: ref }));
        return /** @type {JobOutcome} */ ({ ok: true });
      } catch (error) {
        emit('job.failed', as({ job: { ...ref, error: jobErrorMessage(error) } }));
        return /** @type {JobOutcome} */ ({ ok: false, error });
      } finally {
        active.delete(key);
      }
    }, { priority }).then((v) => /** @type {JobOutcome} */ (v));

    active.set(key, { jobId, done });
    return { jobId, done, duplicate: false };
  }

  return { add, onIdle: () => queue.onIdle(), get size() { return queue.size + queue.pending; } };
}
