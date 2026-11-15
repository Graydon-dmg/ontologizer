// @ts-check
// `add_node`: add exactly one named node under a parent the caller names. No model is called. The
// server's action route and `ontologizer add-node` share addNode(): it checks everything first (a
// refusal writes nothing), then reads the map and appends with no await in between, so two calls at
// once can never be handed the same id. Live views see the node through the normal events stream.
import { childId } from '../../core/engine/ids.js';
import { BUSY, SAVING } from '../texts.js';

/** Control characters (C0, DEL and C1), refused in a label. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Check and write one node. Never throws for a bad input: it answers { status, error } instead.
 * @param {any} store the map's store (read, append)
 * @param {string} id the map id
 * @param {any} input { parentId, label, summary? }
 * @param {{ emit: (t: string, fields: object) => any, busy?: () => boolean, saving?: () => boolean }} o
 *   emit appends one event through the store with the caller's actor stamped
 * @returns {{ status: 201, node: any } | { status: 400 | 404 | 409, error: string }}
 */
export function addNode(store, id, input, { emit, busy, saving }) {
  const { parentId, label: rawLabel, summary: rawSummary } = input ?? {};
  if (typeof parentId !== 'string' || !parentId || rawLabel === undefined || rawLabel === null) {
    return { status: 400, error: 'give parentId and label' };
  }
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (!label || label.length > 80 || CONTROL.test(label)) return { status: 400, error: 'label must be 1 to 80 characters' };
  if (rawSummary !== undefined && rawSummary !== null && (typeof rawSummary !== 'string' || rawSummary.trim().length > 300)) {
    return { status: 400, error: 'summary must be at most 300 characters' };
  }
  if (busy?.()) return { status: 409, error: BUSY };
  if (saving?.()) return { status: 409, error: SAVING };

  // From here to the last append: no await.
  const o = store.read(id);
  // o.nodes is a plain object: "constructor" and the like are not nodes.
  if (!Object.hasOwn(o.nodes, parentId)) return { status: 404, error: `no node "${parentId}"` };
  const parent = o.nodes[parentId];
  const want = label.toLowerCase();
  const same = Object.values(o.nodes).find((n) => n.parent === parentId && String(n.label).trim().toLowerCase() === want);
  if (same) return { status: 409, error: `"${label}" already exists under ${parentId}: ${same.id}` };

  const nid = childId(parentId, label, new Set(Object.keys(o.nodes)));
  const isRootChild = parent.depth === 0;
  // A child of the root is a new category (family 0: the fuse palette's first family).
  if (isRootChild) emit('category.added', { category: { id: nid, label, index: o.categories.length, family: 0 } });
  emit('node.added', { node: { id: nid, label, parent: parentId, category: isRootChild ? nid : parent.category,
    depth: parent.depth + 1, summary: typeof rawSummary === 'string' ? rawSummary.trim() : '', hook: '', origin: 'context',
    sources: [], article: null, status: 'done', createdBy: 'add_node' } });
  return { status: 201, node: store.read(id).nodes[nid] };
}

/**
 * The `add_node` action on POST …/maps/{id}/actions: 201 { ok, node } once what it wrote is stored.
 * @param {any} c { res, body, ctx, store, id, json, emit, ... } from map.js
 */
export async function addNodeAction(c) {
  const { res, body, ctx, store, id, json, emit } = c;
  const r = addNode(store, id, body, { emit, busy: ctx?.busy, saving: ctx?.saving });
  if (r.status !== 201) return json(res, r.status, { ok: false, error: r.error });
  try { await ctx?.sync?.(); } catch { return json(res, 503, { ok: false, error: 'the store is not available' }); }
  return json(res, 201, { ok: true, node: r.node });
}
