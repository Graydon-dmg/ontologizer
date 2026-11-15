// @ts-check
// The hydrate job: one batch of siblings gets job, examples and not_for in one model call. Each node
// that passes is stored at once (node.hydrated); the rest get one retry call; nodes still failing
// are never stored, and the job fails naming them. No web search, no source tools.
import { hydratePrompt } from './prompts-hydrate.js';

const MAX_JOB = 200;
const MAX_EXAMPLE = 200;
const MAX_NOT_FOR = 400;
const MAX_NOT_FOR_IDS = 3;

/** A trimmed string of 1 to max characters, or null. @param {any} v @param {number} max */
function text(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

/**
 * The hydration fields of one model line, or null when any field fails.
 * @param {any} o  the folded map
 * @param {string} id  the node the line answers (already checked to be in the batch)
 * @param {any} line
 * @returns {{ job: string, examples: string[], not_for: string, not_for_ids: string[] } | null}
 */
export function validLine(o, id, line) {
  const node = o.nodes[id];
  const only = Object.values(o.nodes).filter((n) => n.parent === node.parent).length === 1;
  const job = text(line.job, MAX_JOB);
  if (!job) return null;
  const ex = line.examples;
  if (!Array.isArray(ex) || ex.length !== 3) return null;
  const examples = ex.map((e) => text(e, MAX_EXAMPLE));
  if (examples.some((e) => e === null) || new Set(examples).size !== 3) return null;
  const notFor = typeof line.not_for === 'string' ? line.not_for.trim() : null;
  if (notFor === null || notFor.length > MAX_NOT_FOR || (!notFor && !only)) return null;
  const ids = line.not_for_ids;
  if (!Array.isArray(ids) || ids.length > MAX_NOT_FOR_IDS || (!ids.length && !only)) return null;
  if (!ids.every((x) => typeof x === 'string' && x !== id && Object.hasOwn(o.nodes, x))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return { job, examples: /** @type {string[]} */ (examples), not_for: notFor, not_for_ids: [...ids] };
}

/**
 * @param {any} ectx  the engine's run context (store, id, models, emit, call)
 * @param {{ nodeIds: string[], model?: 'sonnet'|'haiku', nodeId: string }} job  nodeId is the parent
 */
export async function hydrateJob(ectx, { nodeIds, model, nodeId: parentId }) {
  const o = ectx.store.read(ectx.id);
  const modelId = model === 'haiku' ? ectx.models.fast : ectx.models.strong;
  const batch = nodeIds.filter((id) => Object.hasOwn(o.nodes, id));
  const done = new Set();

  /** One call over the nodes still to do; stores each passing line as it streams. @param {string[]} ids */
  async function pass(ids) {
    const want = new Set(ids);
    const answered = new Set();
    const { system, prompt } = hydratePrompt(o, parentId, ids);
    await ectx.call({ model: modelId, effort: 'medium', maxTokens: 12000, system, prompt }, (/** @type {any} */ line) => {
      const id = line && typeof line.id === 'string' ? line.id : null;
      if (!id || !want.has(id) || answered.has(id)) return;      // foreign ids and repeats are ignored
      answered.add(id);
      const h = validLine(o, id, line);
      if (!h) return;
      done.add(id);
      ectx.emit('node.hydrated', { nodeId: id, hydration: { ...h, model: modelId, at: new Date().toISOString() } });
    });
  }

  await pass(batch);
  const retry = batch.filter((id) => !done.has(id));
  if (retry.length) await pass(retry);
  const failed = [...nodeIds.filter((id) => !done.has(id))];
  if (failed.length) {
    throw new Error(`hydrate: ${failed.length} of ${nodeIds.length} nodes failed validation: ${failed.slice(0, 10).join(', ')}`);
  }
}
