// @ts-check
// The hydrate action (POST …/actions {type:'hydrate'}) and its planning: validate a request, pick the
// nodes, group them into batches of siblings, reserve the daily limit for all of them, enqueue. The
// planning functions are pure (the CLI uses them too).
import { createHash } from 'node:crypto';

/** @typedef {{ id: string, label: string, parent: string|null, depth: number, hydration?: any }} HNode */
/** @typedef {{ root: string, nodes: Record<string, HNode>, jobs?: Record<string, any> }} HMap */

/** The 400 text for a bad request, or null. @param {HMap} o @param {any} body */
export function validateHydrate(o, body) {
  const b = body ?? {};
  const hasIds = b.nodeIds !== undefined, hasAll = b.all === true;
  if (hasIds && hasAll) return 'give nodeIds or all, not both';
  if (!hasIds && !hasAll) return 'give nodeIds or all';
  if (hasIds) {
    const ids = b.nodeIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 300 || ids.some((x) => typeof x !== 'string')
      || new Set(ids).size !== ids.length) return 'nodeIds must be 1 to 300 different ids';
    for (const id of ids) if (!Object.hasOwn(o.nodes, id)) return `no node "${id}": nothing was started`;
    if (ids.includes(o.root)) return 'the root has nothing to compare with: leave it out';
  }
  if (b.model !== undefined && b.model !== 'sonnet' && b.model !== 'haiku') return 'model must be sonnet or haiku';
  return null;
}

/**
 * @param {HMap} o
 * @param {{ nodeIds?: string[], all?: boolean, redo?: boolean, live?: Set<string> }} req
 *   live: the ids of the jobs the engine still has queued or running (engine.activeJobIds()). A job the
 *   log shows as queued or running but not in live is stale (its process stopped) and skips nothing.
 *   Absent (an engine without activeJobIds): the log alone decides.
 */
export function selectHydrate(o, { nodeIds, all, redo, live }) {
  const ids = all ? Object.keys(o.nodes).filter((id) => id !== o.root) : (nodeIds ?? []);
  const jobs = Object.values(o.jobs ?? {}).filter((j) => j.kind === 'hydrate' && (j.state === 'queued' || j.state === 'running')
    && (!live || live.has(j.id)));
  /** @type {string[]} */ const selected = [];
  /** @type {{ nodeId: string, reason: string }[]} */ const skipped = [];
  for (const id of ids) {
    const job = jobs.find((j) => Array.isArray(j.nodeIds) && j.nodeIds.includes(id));
    if (job) skipped.push({ nodeId: id, reason: `already running in ${job.id}` });
    else if (!redo && o.nodes[id]?.hydration) skipped.push({ nodeId: id, reason: 'already hydrated' });
    else selected.push(id);
  }
  return { selected, skipped };
}

/** Depth per node id, from the parent chain (the fold stores none). @param {HMap} o @param {string} id */
function depthOf(o, id) {
  const seen = new Set([id]);
  let d = 0;
  for (let p = o.nodes[id]?.parent; p && o.nodes[p] && !seen.has(p); p = o.nodes[p].parent) { seen.add(p); d++; }
  return d;
}

/** Descendant count per node id. @param {HMap} o */
function descendants(o) {
  /** @type {Record<string, number>} */ const n = Object.create(null);
  for (const id of Object.keys(o.nodes)) {
    const seen = new Set([id]);
    for (let p = o.nodes[id].parent; p && o.nodes[p] && !seen.has(p); p = o.nodes[p].parent) { seen.add(p); n[p] = (n[p] ?? 0) + 1; }
  }
  return n;
}

/** Group by parent, label order, at most 40 per batch; shallow and big parents first. @param {HMap} o @param {string[]} selected */
export function planBatches(o, selected) {
  /** @type {Map<string, string[]>} */ const groups = new Map();
  for (const id of selected) {
    const p = /** @type {string} */ (o.nodes[id].parent);
    const g = groups.get(p);
    if (g) g.push(id); else groups.set(p, [id]);
  }
  const size = descendants(o);
  const parents = [...groups.keys()].sort((a, b) =>
    depthOf(o, a) - depthOf(o, b) || (size[b] ?? 0) - (size[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  /** @type {{ batch: number, parentId: string, nodeIds: string[] }[]} */ const out = [];
  for (const parentId of parents) {
    const ids = /** @type {string[]} */ (groups.get(parentId)).sort((a, b) => {
      const x = o.nodes[a].label.toLowerCase(), y = o.nodes[b].label.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
    for (let i = 0; i < ids.length; i += 40) out.push({ batch: out.length + 1, parentId, nodeIds: ids.slice(i, i + 40) });
  }
  return out;
}

/** First 12 hex chars of SHA-256 over the sorted ids. @param {string[]} nodeIds */
export const idsHash = (nodeIds) => createHash('sha256').update([...nodeIds].sort().join('\n')).digest('hex').slice(0, 12);

/** @param {string} parentId @param {string[]} nodeIds */
export const dedupeKey = (parentId, nodeIds) => `hydrate:${parentId}:${idsHash(nodeIds)}`;

/** @param {{ nodeIds: string[] }[]} batches */
export const estimate = (batches) => ({ calls: batches.length, tokens: batches.reduce((s, b) => s + b.nodeIds.length, 0) * 700 });

/**
 * After map.js's MODEL_ACTIONS gate (one call already checked). All or nothing: when the batches would
 * pass the daily limit, nothing starts (429). No source tools: hydrate never searches.
 * @param {{ res: any, body: any, ctx: any, engine: any, store: any, id: string, who: any,
 *           json: Function, ok: (reply: any) => any, bad: (error: string) => any }} c
 */
export async function hydrateAction(c) {
  const { res, body, ctx, engine, store, id, who, json, ok, bad } = c;
  const o = store.read(id);
  const error = validateHydrate(o, body);
  if (error) return bad(error);
  const model = body.model ?? 'sonnet';
  const live = typeof engine.activeJobIds === 'function' ? engine.activeJobIds() : undefined;
  const { selected, skipped } = selectHydrate(o, { nodeIds: body.nodeIds, all: body.all === true, redo: body.redo === true, live });
  const batches = planBatches(o, selected);
  if (!batches.length) return json(res, 200, { ok: true, jobs: [], skipped, estimate: { calls: 0, tokens: 0 } });
  const over = ctx?.limit ? ctx.limit(batches.length - 1, ctx.calls ? ctx.calls() : null) : null;
  if (over) return json(res, 429, { ok: false, error: over.error }, { 'Retry-After': String(over.retryAfter) });
  /** @type {{ batch: number, parentId: string, nodeIds: string[], jobId: string }[]} */ const jobs = [];
  for (const b of batches) {
    const r = await engine.enqueue({ kind: 'hydrate', nodeId: b.parentId, dedupeKey: dedupeKey(b.parentId, b.nodeIds), nodeIds: b.nodeIds, model },
      { priority: 5, ...who });
    jobs.push({ ...b, jobId: typeof r === 'string' ? r : (r?.jobId ?? r?.id) });
  }
  return ok({ ok: true, jobs, skipped, estimate: estimate(batches) });
}
