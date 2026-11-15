// @ts-check
/** OntoEvent:
 *  { t: 'ontology.created', at, name, root, brief, categories: [], mode? }   always the first event
 *    mode: 'agent'|'human' (organize_map sets it). Any other value, or none, adds no mode key.
 *  { t: 'category.added', at, category }
 *  { t: 'node.added', at, node }
 *  { t: 'node.updated', at, id, patch }            shallow merge into the node
 *  { t: 'node.hydrated', at, nodeId, hydration: { job, examples, not_for, not_for_ids, model, at } }
 *    Sets node.hydration (a copy). Ignored, never thrown on, when the node is unknown or the
 *    hydration is malformed (examples / not_for_ids not string arrays, other fields not strings).
 *  { t: 'edge.added', at, edge }
 *  { t: 'view.changed', at, patch }                shallow merge into view (filter merges one level deeper)
 *  { t: 'lens.added', at, lens }                   lens.analogs may start empty
 *  { t: 'lens.analog', at, lensId, nodeId, label, breaks? }
 *  { t: 'job.queued'|'job.started'|'job.done'|'job.failed', at, job: { id, kind, nodeId?, error? } }
 *  { t: 'insight', at, text, nodeId? }
 *  { t: 'ontology.renamed', at, name }             written by save
 *  { t: 'chat.asked', at, chatId, msgId, text, images: [{ hash, mime, w, h }] }
 *  { t: 'chat.answered', at, chatId, msgId, replyTo, text, citations: [{ nodeId, label }],
 *    sources: [{ title, url }], suggestions: [{ kind: 'research', nodeId, mode: 'context'|'general', label }],
 *    usedWeb: boolean }
 *  { t: 'chat.failed', at, chatId, replyTo, error, msgId? }   msgId defaults to 'err:' + replyTo
 *    The three chat events append to ontology.chat in order (roles user / assistant / error).
 *    Only the fields above are kept; unknown fields are dropped. A repeated msgId is ignored.
 *  { t: 'visibility.raised', at, to: 'private', reason: 'source'|'fuse', sources: [names] }
 *    The map used a private source (or fused a private map). ontology.visibility becomes 'private' and
 *    ontology.privateSources gains the names. Nothing lowers visibility: there is no event for it.
 *    A map already private with no names (admin only) stays admin only: later names are not added.
 *
 * Service mode stamps an optional top-level `actor: { id, kind, via? }` on every event a request
 * causes; fold ignores it.
 *
 * Unknown event types are ignored (forward compatible). A node.added whose parent is missing is
 * still folded; views must tolerate a parent that arrives later.
 * View defaults: { collapsed: [], focus: <root>, layout: 'graph-2d', lens: null,
 *                  filter: { categories: null, maxDepth: null } }
 */

/** @typedef {import('./schema.js').Ontology} Ontology */
/** @typedef {{ t: string, at: number, [k: string]: any }} OntoEvent */

/** @type {Record<string, 'queued'|'running'|'done'|'failed'>} */
const JOB_STATE = {
  'job.queued': 'queued',
  'job.started': 'running',
  'job.done': 'done',
  'job.failed': 'failed',
};

/** A valid Ontology with no nodes. @returns {Ontology} */
export function emptyOntology() {
  return {
    name: '',
    root: '',
    version: 1,
    brief: { context: '', subject: '', scope: '', purpose: '', level: 'beginner' },
    categories: [],
    nodes: {},
    edges: [],
    lenses: {},
    view: {
      collapsed: [],
      focus: '',
      layout: 'graph-2d',
      lens: null,
      filter: { categories: null, maxDepth: null },
    },
    jobs: {},
    insights: [],
    chat: [],
    visibility: 'public',
    privateSources: [],
  };
}

/**
 * Pure: returns a NEW ontology; never mutates its inputs; never reads the clock.
 * Unchanged branches are shared with the input (treat the result as immutable).
 * @param {Ontology} o
 * @param {OntoEvent} e
 * @returns {Ontology}
 */
export function fold(o, e) {
  return step(o, e, false);
}

/**
 * Applies e to o IN PLACE and returns o. o must be an accumulator the caller owns (from
 * emptyOntology() or foldAll()), never a fold() result that shares branches with something else.
 * The result equals fold's, key order included. What it stores is still copied from the event.
 * @param {Ontology} o
 * @param {OntoEvent} e
 * @returns {Ontology}
 */
export function foldInto(o, e) {
  return step(o, e, true);
}

/**
 * Every case, once. With own false each write copies the branch it changes (fold); with own true
 * it writes into o's own objects (foldInto). Either way new keys append and a replaced key keeps
 * its position, so both give the same JSON.
 * @param {Ontology} o
 * @param {OntoEvent} e
 * @param {boolean} own
 * @returns {Ontology}
 */
function step(o, e, own) {
  if (!e || typeof e !== 'object') return o;
  switch (e.t) {
    case 'ontology.created': {
      const root = e.root ?? '';
      return assign(o, {
        name: e.name ?? o.name,
        root,
        brief: e.brief ? { ...e.brief } : o.brief,
        categories: Array.isArray(e.categories) ? e.categories.map((c) => ({ ...c })) : o.categories,
        view: { ...o.view, focus: root },
        ...(e.mode === 'agent' || e.mode === 'human' ? { mode: e.mode } : {}),
      }, own);
    }
    case 'ontology.renamed':
      return assign(o, { name: e.name }, own);
    case 'category.added':
      return assign(o, { categories: upsert(o.categories, { ...e.category }, own) }, own);
    case 'node.added': {
      const n = e.node;
      if (!n || !n.id) return o;
      return assign(o, { nodes: put(o.nodes, n.id, copyNode(n), own) }, own);
    }
    case 'node.updated': {
      const prev = entry(o.nodes, e.id);
      if (!prev) return o;
      return assign(o, { nodes: put(o.nodes, e.id, { ...prev, ...(e.patch || {}) }, own) }, own);
    }
    case 'node.hydrated': {
      const h = hydration(e.hydration);
      if (!h || typeof e.nodeId !== 'string' || !Object.hasOwn(o.nodes, e.nodeId)) return o;
      return assign(o, { nodes: put(o.nodes, e.nodeId, { ...o.nodes[e.nodeId], hydration: h }, own) }, own);
    }
    case 'edge.added':
      return assign(o, { edges: upsert(o.edges, { ...e.edge }, own) }, own);
    case 'view.changed': {
      const patch = e.patch || {};
      const view = { ...o.view, ...patch };
      view.filter = { ...o.view.filter, ...(patch.filter || {}) };
      if (patch.collapsed) view.collapsed = patch.collapsed.slice();
      return assign(o, { view }, own);
    }
    case 'lens.added': {
      const l = e.lens;
      if (!l || !l.id) return o;
      return assign(o, { lenses: put(o.lenses, l.id, { ...l, analogs: { ...(l.analogs || {}) } }, own) }, own);
    }
    case 'lens.analog': {
      const l = entry(o.lenses, e.lensId);
      if (!l || !plain(l.analogs)) return o;
      /** @type {{ label: string, breaks?: string }} */
      const a = { label: e.label };
      if (e.breaks !== undefined) a.breaks = e.breaks;
      const lens = assign(l, { analogs: put(l.analogs, e.nodeId, a, own) }, own);
      return assign(o, { lenses: put(o.lenses, l.id, lens, own) }, own);
    }
    case 'job.queued':
    case 'job.started':
    case 'job.done':
    case 'job.failed': {
      const j = e.job;
      if (!j || !j.id) return o;
      const prev = entry(o.jobs, j.id) || {};
      /** @type {any} */
      const job = { ...prev, ...j, state: JOB_STATE[e.t] };
      if (Array.isArray(j.nodeIds)) job.nodeIds = [...j.nodeIds]; // the record never shares the event's array
      if (e.t !== 'job.failed' && j.error === undefined) delete job.error;
      return assign(o, { jobs: put(o.jobs, j.id, job, own) }, own);
    }
    case 'insight': {
      /** @type {{ at: number, text: string, nodeId?: string }} */
      const ins = { at: e.at, text: e.text };
      if (e.nodeId !== undefined) ins.nodeId = e.nodeId;
      return assign(o, { insights: push(o.insights, ins, own) }, own);
    }
    case 'chat.asked':
    case 'chat.answered':
    case 'chat.failed': {
      const m = chatMessage(e);
      const chat = o.chat ?? [];
      if (!m || chat.some((x) => x.msgId === m.msgId)) return o.chat ? o : assign(o, { chat }, own);
      return assign(o, { chat: push(chat, m, own) }, own);
    }
    case 'visibility.raised': {
      if (e.to !== 'private') return o; // only ever raised; anything else is ignored
      // A private map that names no source is admin only: it stays that way, so a later source can
      // never widen who may read it.
      if (o.visibility === 'private' && !(o.privateSources || []).length) return o;
      const names = new Set(Array.isArray(o.privateSources) ? o.privateSources : []);
      for (const n of Array.isArray(e.sources) ? e.sources : []) if (typeof n === 'string' && n) names.add(n);
      return assign(o, { visibility: 'private', privateSources: [...names].sort() }, own);
    }
    default:
      return o; // unknown event types are ignored
  }
}

/**
 * map[k] only when it is map's own key: an event-supplied key such as `constructor`, `toString` or
 * `__proto__` must never reach a built-in (foldInto would write into it, fold would fold junk).
 * @param {Record<string, any>} map @param {unknown} k
 */
const entry = (map, k) => ((typeof k === 'string' || typeof k === 'number') && Object.hasOwn(map, k) ? map[k] : undefined);
/** @param {unknown} x */
const plain = (x) => Boolean(x) && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype;

// The write helpers step uses: in place when own, else a copy of the changed branch. Object.assign
// and spread both keep an existing key where it is and append a new one.

/** @template T @param {T} o @param {Partial<T>} fields @param {boolean} own @returns {T} */
const assign = (o, fields, own) => (own ? Object.assign(o, fields) : { ...o, ...fields });

/**
 * Set map[k]. `__proto__` must stay an own key, as the computed key in a literal makes it.
 * @param {Record<string, any>} map @param {string} k @param {any} v @param {boolean} own
 */
function put(map, k, v, own) {
  if (!own) return { ...map, [k]: v };
  if (k === '__proto__') Object.defineProperty(map, k, { value: v, writable: true, enumerable: true, configurable: true });
  else map[k] = v;
  return map;
}

/** @param {any[]} list @param {any} x @param {boolean} own */
const push = (list, x, own) => (own ? (list.push(x), list) : [...list, x]);

/**
 * Replace the first item with x's id, or append x. In place, a per-list id index (rebuilt when
 * the list's length is not what it last saw) keeps a long run of edges linear.
 * @param {any[]} list @param {{ id: string }} x @param {boolean} own
 */
function upsert(list, x, own) {
  if (!own) {
    const i = list.findIndex((y) => y.id === x.id);
    const next = list.slice();
    if (i >= 0) next[i] = x;
    else next.push(x);
    return next;
  }
  let ix = ids.get(list);
  if (!ix || ix.size !== list.length) {
    ix = new Map();
    for (let i = 0; i < list.length; i++) if (!ix.has(list[i].id)) ix.set(list[i].id, i);
    ids.set(list, ix);
  }
  const i = ix.get(x.id);
  if (i !== undefined) list[i] = x;
  else { ix.set(x.id, list.length); list.push(x); }
  return list;
}
/** @type {WeakMap<any[], Map<string, number>>} */
const ids = new WeakMap();

/** @param {any} n */
function copyNode(n) {
  return {
    ...n,
    sources: Array.isArray(n.sources) ? n.sources.map((/** @type {any} */ s) => ({ ...s })) : [],
    article: n.article ?? null,
  };
}

/** @param {any} a */
const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

/**
 * A copy of a well-formed hydration, or null.
 * @param {any} h
 * @returns {import('./schema.js').Hydration|null}
 */
function hydration(h) {
  if (!h || typeof h !== 'object' || !strings(h.examples) || !strings(h.not_for_ids)) return null;
  if (![h.job, h.not_for, h.model, h.at].every((x) => typeof x === 'string')) return null;
  return {
    job: h.job, examples: [...h.examples], not_for: h.not_for,
    not_for_ids: [...h.not_for_ids], model: h.model, at: h.at,
  };
}

/** @param {any[]|undefined} a @param {(x: any) => any} f */
const mapList = (a, f) => (Array.isArray(a) ? a.map(f) : []);

/**
 * Build a chat message from a chat event, keeping only contract fields.
 * @param {OntoEvent} e
 * @returns {import('./schema.js').ChatMessage|null}
 */
function chatMessage(e) {
  const chatId = typeof e.chatId === 'string' && e.chatId ? e.chatId : 'main';
  if (e.t === 'chat.asked') {
    if (!e.msgId) return null;
    return {
      role: 'user', chatId, msgId: e.msgId, text: String(e.text ?? ''), at: e.at,
      images: mapList(e.images, (i) => ({ hash: i.hash, mime: i.mime, w: i.w, h: i.h })),
    };
  }
  if (e.t === 'chat.answered') {
    if (!e.msgId) return null;
    return {
      role: 'assistant', chatId, msgId: e.msgId, replyTo: e.replyTo, text: String(e.text ?? ''), at: e.at,
      citations: mapList(e.citations, (c) => ({ nodeId: c.nodeId, label: c.label })),
      sources: mapList(e.sources, (s) => ({ title: s.title, url: s.url })),
      suggestions: mapList(e.suggestions, (s) => ({ kind: s.kind, nodeId: s.nodeId, mode: s.mode, label: s.label })),
      usedWeb: e.usedWeb === true,
    };
  }
  // chat.failed
  return {
    role: 'error', chatId, msgId: e.msgId || `err:${e.replyTo}`, replyTo: e.replyTo,
    text: String(e.error ?? ''), at: e.at,
  };
}

/** Fold from emptyOntology(). @param {OntoEvent[]} events @returns {Ontology} */
export function foldAll(events) {
  const o = emptyOntology();
  for (const e of events) foldInto(o, e);
  return o;
}

/**
 * @param {string} t
 * @param {Record<string, any>} fields
 * @param {number} startedAt  ms timestamp when the ontology was created
 * @returns {OntoEvent}
 */
export function makeEvent(t, fields, startedAt) {
  return { t, at: Date.now() - startedAt, ...fields };
}
