// @ts-check
// organize_map: a supplied list of items -> families (pass 1) -> placement (pass 2) -> events.
// Every item becomes exactly one leaf with its own id; an item the model could not place goes under
// _root/unsorted, never dropped. Families are written only after placement, and only those with at
// least one leaf below them, so a finished map never has an empty family.
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { childId, norm } from './ids.js';
import { isAuthError, jobErrorMessage } from './call.js';
import { familiesPrompt, placementPrompt } from './prompts-organize.js';

export const ROOT_ID = '_root';
export const UNSORTED_ID = '_root/unsorted';
export const BAD_TREE = 'organize: the model did not return a valid family tree';
export const MAX_ITEMS = { agent: 10000, human: 500 };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,119}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SAMPLE = 2000;
const TEXT_CUT = 120;
const BATCH = 200;
const RETRY_BATCH = 50;
const CONCURRENCY = 3;
const SMALL_LIST = 24;

/** A call stopped by the run's own signal (a timeout or the server stopping): never retried. @param {any} e */
const isAbort = (e) => e?.name === 'AbortError' || e?.name === 'APIUserAbortError';
/** The tenant's daily limit was reached (the server's UsageLimitError): every later call fails too. @param {any} e */
const isUsageLimit = (e) => e?.code === 'USAGE_LIMIT';

/** @typedef {{ id: string, label: string, text?: string }} Item */
/** @typedef {{ name: string, items: Item[], depth: 2|3|4, mode: 'agent'|'human' }} OrganizeInput */
/** @typedef {{ key: string, label: string, parent: string|null, description: string, level: number, children: string[] }} Family */

/**
 * Validate an organise request (the route and the CLI share it). Returns the clean input, or the
 * first error in the order of the contract's table.
 * @param {any} body
 * @returns {{ ok: true, input: OrganizeInput } | { ok: false, error: string }}
 */
export function checkInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 120) return { ok: false, error: 'name must be 1 to 120 characters' };
  const mode = b.mode === undefined ? 'agent' : b.mode;
  if (mode !== 'agent' && mode !== 'human') return { ok: false, error: 'mode must be agent or human' };
  const max = mode === 'human' ? MAX_ITEMS.human : MAX_ITEMS.agent;
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > max) {
    return { ok: false, error: `items must be a list of 1 to ${max} items` };
  }
  /** @type {Item[]} */
  const items = [];
  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i] && typeof b.items[i] === 'object' ? b.items[i] : {};
    if (typeof it.id !== 'string' || !ID_RE.test(it.id)) {
      return { ok: false, error: `item ${i}: id must be 1 to 120 letters, digits or . _ : ~ - and may not start with _` };
    }
    if (it.id in Object.prototype) return { ok: false, error: `item ${i}: "${it.id}" is a reserved name` };
    const label = typeof it.label === 'string' ? it.label.trim() : '';
    if (!label || label.length > 80 || CONTROL.test(label)) return { ok: false, error: `item ${i}: label must be 1 to 80 characters` };
    if (it.text !== undefined && (typeof it.text !== 'string' || it.text.length > 500)) {
      return { ok: false, error: `item ${i}: text must be at most 500 characters` };
    }
    items.push(typeof it.text === 'string' ? { id: it.id, label, text: it.text } : { id: it.id, label });
  }
  const seen = new Set();
  /** @type {string[]} */
  const dups = [];
  for (const it of items) {
    if (seen.has(it.id)) { if (!dups.includes(it.id)) dups.push(it.id); } else seen.add(it.id);
  }
  if (dups.length) return { ok: false, error: `duplicate ids: ${dups.slice(0, 5).join(', ')}` };
  const depth = b.depth === undefined ? 3 : b.depth;
  if (!Number.isInteger(depth) || depth < 2 || depth > 4) return { ok: false, error: 'depth must be 2, 3 or 4' };
  return { ok: true, input: { name, items, depth: /** @type {2|3|4} */ (depth), mode } };
}

/** The depth actually built: lists under 24 items get one family level. @param {number} n @param {number} depth */
export const effectiveDepth = (n, depth) => (n < SMALL_LIST ? 2 : depth);

/** The most deepest families a tree may have. @param {number} n */
export const maxDeepest = (n) => Math.min(200, Math.max(8, Math.ceil(n / 5)));

/** Every ⌈n/2000⌉-th item, in input order (all of them up to 2,000). @template T @param {T[]} items @returns {T[]} */
export function sampleItems(items) {
  if (items.length <= SAMPLE) return items;
  const step = Math.ceil(items.length / SAMPLE);
  return items.filter((_, i) => i % step === 0);
}

/**
 * Read pass 1's lines into a family tree and list what is wrong with it.
 * @param {any[]} lines @param {number} depth @param {number} maxDeep
 * @returns {{ families: Map<string, Family>, tops: string[], deepest: string[], problems: string[] }}
 */
export function readTree(lines, depth, maxDeep) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, Family>} */
  const families = new Map();
  for (const l of lines) {
    if (!l || typeof l.key !== 'string' || !l.key.trim()) continue;
    const key = l.key.trim();
    const label = typeof l.label === 'string' ? l.label.trim() : '';
    if (!label || label.length > 80 || CONTROL.test(label)) { problems.push(`family "${key}" has no usable label (1 to 80 characters)`); continue; }
    if (families.has(key) || key === 'ROOT') { problems.push(`the key "${key}" is used more than once`); continue; }
    const parent = typeof l.parent === 'string' && l.parent.trim() && l.parent.trim() !== 'ROOT' ? l.parent.trim() : null;
    families.set(key, { key, label, parent, description: typeof l.description === 'string' ? l.description.trim() : '', level: 0, children: [] });
  }
  for (const f of families.values()) {
    if (f.parent === null) continue;
    const p = families.get(f.parent);
    if (!p) { problems.push(`family "${f.key}" names a parent "${f.parent}" that is not in the tree`); f.parent = null; f.level = -1; continue; }
    p.children.push(f.key);
  }
  // Levels from the top down; anything unreachable (a cycle) keeps level 0 and is reported.
  /** @type {string[]} */
  const tops = [...families.values()].filter((f) => f.parent === null && f.level === 0).map((f) => f.key);
  /** @type {string[]} */
  const order = [];
  for (const k of tops) { /** @type {Family} */ (families.get(k)).level = 1; order.push(k); }
  for (let i = 0; i < order.length; i++) {
    const f = /** @type {Family} */ (families.get(order[i]));
    for (const c of f.children) {
      const child = /** @type {Family} */ (families.get(c));
      if (child.level) continue;
      child.level = f.level + 1;
      order.push(c);
    }
  }
  for (const f of families.values()) if (f.level <= 0 && f.parent !== null) problems.push(`family "${f.key}" is not connected to the top level`);

  const deep = depth - 1;
  if (tops.length < 4 || tops.length > 12) problems.push(`there are ${tops.length} top-level families; give 4 to 12`);
  for (const k of order) {
    const f = /** @type {Family} */ (families.get(k));
    if (f.level > deep) problems.push(`family "${f.key}" is at level ${f.level}; the deepest level is ${deep}`);
    else if (f.level < deep && (f.children.length < 2 || f.children.length > 12)) {
      problems.push(`family "${f.key}" has ${f.children.length} sub-families; every family above level ${deep} needs 2 to 12`);
    } else if (f.level === deep && f.children.length) problems.push(`family "${f.key}" is at the deepest level (${deep}) and may not have sub-families`);
  }
  for (const sibs of [tops, ...[...families.values()].map((f) => f.children)]) {
    const labels = new Set();
    for (const s of sibs) {
      const l = norm(/** @type {Family} */ (families.get(s)).label);
      if (labels.has(l)) problems.push(`the label "${/** @type {Family} */ (families.get(s)).label}" is used by more than one family under the same parent`);
      labels.add(l);
    }
  }
  const deepest = order.filter((k) => /** @type {Family} */ (families.get(k)).level === deep);
  if (deepest.length > maxDeep) problems.push(`there are ${deepest.length} deepest families; give at most ${maxDeep}`);
  return { families, tops, deepest, problems };
}

/** Labels from the top family down to this one. @param {Map<string, Family>} families @param {string} key */
function pathOf(families, key) {
  /** @type {string[]} */
  const out = [];
  for (let f = families.get(key); f; f = f.parent ? families.get(f.parent) : undefined) out.unshift(f.label);
  return out.join(' › ');
}


/** @param {object} p */
const node = (p) => ({ summary: '', hook: '', sources: [], article: null, status: 'done', ...p });

/**
 * The events before any model call: ontology.created, the agent view, the root node.
 * @param {(t: string, fields: object) => void} emit @param {{ name: string, n: number, mode: 'agent'|'human' }} o
 */
export function begin(emit, { name, n, mode }) {
  const brief = { context: `Organised from ${n} supplied items`, subject: name, scope: '', purpose: '', level: 'expert' };
  emit('ontology.created', { name, root: ROOT_ID, brief, categories: [], mode });
  if (mode === 'agent') emit('view.changed', { patch: { filter: { maxDepth: 2 } } });
  emit('node.added', { node: node({ id: ROOT_ID, label: name, parent: null, category: '', depth: 0, origin: 'seed', createdBy: 'organize' }) });
}

/**
 * The events after placement: families with at least one leaf below them (parents before children,
 * each top-level one with its category.added), Unsorted when used, then every leaf in input order.
 * Shared with the stub, so both write the same shape. Returns the number of family nodes written.
 * @param {(t: string, fields: object) => void} emit
 * @param {{ n: number, items: Item[], families: Map<string, Family>, tops: string[], placed: Map<string, string> }} o
 */
export function writeMap(emit, { n, items, families, tops, placed }) {
  /** @type {Map<string, number>} */
  const leaves = new Map();
  for (const key of placed.values()) {
    for (let f = families.get(key); f; f = f.parent ? families.get(f.parent) : undefined) leaves.set(f.key, (leaves.get(f.key) ?? 0) + 1);
  }
  const taken = new Set([ROOT_ID, UNSORTED_ID, ...items.map((it) => it.id)]);
  /** @type {Map<string, string>} family key -> node id */
  const idOf = new Map();
  /** @type {Map<string, string>} family key -> its top-level family's node id */
  const catOf = new Map();
  let index = 0;
  let written = 0;
  // Breadth first: every top-level family (with its category.added), then level 2, then level 3.
  /** @type {string[]} */
  let level = tops.filter((k) => leaves.has(k));
  while (level.length) {
    /** @type {string[]} */
    const next = [];
    for (const k of level) {
      const f = /** @type {Family} */ (families.get(k));
      const parentId = f.parent ? /** @type {string} */ (idOf.get(f.parent)) : ROOT_ID;
      const id = childId(parentId, f.label, taken);
      taken.add(id);
      idOf.set(k, id);
      const category = f.parent ? /** @type {string} */ (catOf.get(f.parent)) : id;
      catOf.set(k, category);
      if (!f.parent) emit('category.added', { category: { id, label: f.label, index: index++, family: 0 } });
      emit('node.added', { node: node({ id, label: f.label, parent: parentId, category, depth: f.level, summary: f.description, origin: 'context', createdBy: 'organize' }) });
      written++;
      for (const c of f.children) if (leaves.has(c)) next.push(c);
    }
    level = next;
  }
  const unsorted = items.filter((it) => !placed.has(it.id));
  if (unsorted.length) {
    emit('category.added', { category: { id: UNSORTED_ID, label: 'Unsorted', index: index++, family: 0 } });
    emit('node.added', { node: node({ id: UNSORTED_ID, label: 'Unsorted', parent: ROOT_ID, category: UNSORTED_ID, depth: 1,
      summary: 'Items the model could not place.', origin: 'context', createdBy: 'organize' }) });
    written++;
  }

  // Leaves, in input order.
  for (const it of items) {
    const key = placed.get(it.id);
    const parentId = key ? /** @type {string} */ (idOf.get(key)) : UNSORTED_ID;
    const fam = key ? /** @type {Family} */ (families.get(key)) : null;
    emit('node.added', { node: node({ id: it.id, label: it.label, parent: parentId, category: key ? catOf.get(key) : UNSORTED_ID,
      depth: fam ? fam.level + 1 : 2, summary: it.text ?? '', origin: 'seed', createdBy: 'organize', status: 'done' }) });
  }
  if (unsorted.length) emit('insight', { text: `${unsorted.length} of ${n} items could not be placed and are under Unsorted.` });
  return written;
}

/**
 * @param {any} ectx  the engine's run context (runCtx('organize', o)): emit, call, models, durable, resetClock
 * @param {any} input  { name, items, depth?, mode?, jobId? }, validated again here. jobId: the run's job
 *   id when the caller owns the run (the server's startRun), which then ends a failed run's job itself
 * @returns {Promise<{ items: number, families: number, unsorted: number }>}
 */
export async function organize(ectx, input) {
  const checked = checkInput(input);
  if (!checked.ok) throw new Error(`organize: ${checked.error}`);
  const { name, items, mode } = checked.input;
  const n = items.length;
  const depth = effectiveDepth(n, checked.input.depth);
  const maxDeep = maxDeepest(n);

  ectx.resetClock?.();
  begin(ectx.emit, { name, n, mode });
  // The run is a job from its first write to its last: a run killed in between (a crash, a restart)
  // is left started-but-not-done, which the server's restart check marks failed.
  const owned = typeof input?.jobId === 'string' && input.jobId !== '';
  const job = { id: owned ? input.jobId : `organize-${randomUUID().slice(0, 8)}`, kind: 'organize' };
  ectx.emit('job.started', { job });
  try {
    const out = await passes(ectx, { name, items, n, depth, maxDeep });
    ectx.emit('job.done', { job });
    await ectx.durable?.();
    return out;
  } catch (e) {
    // A server run's job is ended by its caller, under the same id (one entry); a CLI run ends its own.
    if (!owned) ectx.emit('job.failed', { job: { ...job, error: jobErrorMessage(e) } });
    throw e;
  }
}

/**
 * Pass 1 (the family tree), pass 2 (placement, then one retry), then the map's events.
 * @param {any} ectx @param {{ name: string, items: Item[], n: number, depth: number, maxDeep: number }} o
 */
async function passes(ectx, { name, items, n, depth, maxDeep }) {
  // ---- Pass 1: the family tree (one retry with the problems listed).
  const sample = sampleItems(items).map((it) => ({ label: it.label, ...(it.text ? { text: it.text.slice(0, TEXT_CUT) } : {}) }));
  /** @type {ReturnType<typeof readTree> | null} */
  let tree = null;
  /** @type {string[]|undefined} */
  let problems;
  for (let attempt = 0; attempt < 2; attempt++) {
    /** @type {any[]} */
    const got = [];
    await ectx.call({ model: ectx.models.strong, effort: 'medium', maxTokens: 8000,
      ...familiesPrompt({ name, items: sample, depth: /** @type {2|3|4} */ (depth), maxDeepest: maxDeep, total: n, ...(problems ? { problems } : {}) }) },
    (/** @type {any} */ obj) => { got.push(obj); });
    const t = readTree(got, depth, maxDeep);
    if (!t.problems.length && t.deepest.length) { tree = t; break; }
    problems = t.problems.length ? t.problems : ['the tree was empty'];
  }
  if (!tree) throw new Error(BAD_TREE);
  const { families, deepest } = tree;
  const deepSet = new Set(deepest);
  const famList = deepest.map((k) => {
    const f = /** @type {Family} */ (families.get(k));
    return { key: k, label: f.label, path: pathOf(families, k), description: f.description };
  });

  // ---- Pass 2: placement, in batches of 200 (3 at a time), then one retry in batches of 50.
  /** @type {Map<string, string>} item id -> deepest family key */
  const placed = new Map();
  /** @param {Item[]} batch @param {boolean} retry */
  const place = (batch, retry) => {
    const ids = new Set(batch.map((it) => it.id));
    return ectx.call({ model: ectx.models.strong, effort: 'low', maxTokens: 12000,
      ...placementPrompt({ name, families: famList, items: batch, ...(retry ? { retry: true } : {}) }) },
    (/** @type {any} */ obj) => {
      if (!obj || typeof obj.id !== 'string' || !ids.has(obj.id) || placed.has(obj.id)) return;
      if (typeof obj.family !== 'string' || !deepSet.has(obj.family)) return;
      placed.set(obj.id, obj.family);
    });
  };
  /** @param {Item[]} list @param {number} size @param {boolean} retry */
  async function run(list, size, retry) {
    const queue = new PQueue({ concurrency: CONCURRENCY });
    /** @type {any} */
    let fatal = null;
    for (let i = 0; i < list.length; i += size) {
      const batch = list.slice(i, i + size);
      queue.add(async () => {
        if (fatal) return;
        try {
          await place(batch, retry);
        } catch (e) {
          // A rejected key, the daily limit or the run's own abort ends the run. Any other failure (an overload, the
          // network) only costs that batch: its items get the retry, and a failed retry batch's items
          // go under Unsorted, so what was placed already is kept.
          if (isAuthError(e) || isAbort(e) || isUsageLimit(e)) { fatal ??= e; queue.clear(); }
        }
      });
    }
    await queue.onIdle();
    if (fatal) throw fatal;
  }
  await run(items, BATCH, false);
  const missed = items.filter((it) => !placed.has(it.id));
  if (missed.length) await run(missed, RETRY_BATCH, true);

  const written = writeMap(ectx.emit, { n, items, families, tops: tree.tops, placed });
  return { items: n, families: written, unsorted: n - placed.size };
}
