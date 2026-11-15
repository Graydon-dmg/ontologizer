// @ts-check
// Frozen 1.8.0 fold plus S's two cases (mode, node.hydrated): the oracle for E's equivalence test. Never edit.

/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */
/** @typedef {{ t: string, at: number, [k: string]: any }} OntoEvent */

/** @type {Record<string, 'queued'|'running'|'done'|'failed'>} */
const JOB_STATE = {
  'job.queued': 'queued',
  'job.started': 'running',
  'job.done': 'done',
  'job.failed': 'failed',
};

/** A valid Ontology with no nodes. @returns {Ontology} */
function emptyOntology180() {
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
function fold180(o, e) {
  if (!e || typeof e !== 'object') return o;
  switch (e.t) {
    case 'ontology.created': {
      const root = e.root ?? '';
      return {
        ...o,
        name: e.name ?? o.name,
        root,
        brief: e.brief ? { ...e.brief } : o.brief,
        categories: Array.isArray(e.categories) ? e.categories.map((c) => ({ ...c })) : o.categories,
        view: { ...o.view, focus: root },
        ...(e.mode === 'agent' || e.mode === 'human' ? { mode: e.mode } : {}),
      };
    }
    case 'ontology.renamed':
      return { ...o, name: e.name };
    case 'category.added': {
      const c = { ...e.category };
      const i = o.categories.findIndex((x) => x.id === c.id);
      const categories = o.categories.slice();
      if (i >= 0) categories[i] = c;
      else categories.push(c);
      return { ...o, categories };
    }
    case 'node.added': {
      const n = e.node;
      if (!n || !n.id) return o;
      return { ...o, nodes: { ...o.nodes, [n.id]: copyNode(n) } };
    }
    case 'node.updated': {
      const prev = o.nodes[e.id];
      if (!prev) return o;
      return { ...o, nodes: { ...o.nodes, [e.id]: { ...prev, ...(e.patch || {}) } } };
    }
    case 'node.hydrated': {
      const h = hydration(e.hydration);
      if (!h || typeof e.nodeId !== 'string' || !Object.hasOwn(o.nodes, e.nodeId)) return o;
      return { ...o, nodes: { ...o.nodes, [e.nodeId]: { ...o.nodes[e.nodeId], hydration: h } } };
    }
    case 'edge.added': {
      const ed = { ...e.edge };
      const i = o.edges.findIndex((x) => x.id === ed.id);
      const edges = o.edges.slice();
      if (i >= 0) edges[i] = ed;
      else edges.push(ed);
      return { ...o, edges };
    }
    case 'view.changed': {
      const patch = e.patch || {};
      const view = { ...o.view, ...patch };
      view.filter = { ...o.view.filter, ...(patch.filter || {}) };
      if (patch.collapsed) view.collapsed = patch.collapsed.slice();
      return { ...o, view };
    }
    case 'lens.added': {
      const l = e.lens;
      if (!l || !l.id) return o;
      return { ...o, lenses: { ...o.lenses, [l.id]: { ...l, analogs: { ...(l.analogs || {}) } } } };
    }
    case 'lens.analog': {
      const l = o.lenses[e.lensId];
      if (!l) return o;
      /** @type {{ label: string, breaks?: string }} */
      const a = { label: e.label };
      if (e.breaks !== undefined) a.breaks = e.breaks;
      return {
        ...o,
        lenses: { ...o.lenses, [l.id]: { ...l, analogs: { ...l.analogs, [e.nodeId]: a } } },
      };
    }
    case 'job.queued':
    case 'job.started':
    case 'job.done':
    case 'job.failed': {
      const j = e.job;
      if (!j || !j.id) return o;
      const prev = o.jobs[j.id] || {};
      /** @type {any} */
      const job = { ...prev, ...j, state: JOB_STATE[e.t] };
      if (e.t !== 'job.failed' && j.error === undefined) delete job.error;
      return { ...o, jobs: { ...o.jobs, [j.id]: job } };
    }
    case 'insight': {
      /** @type {{ at: number, text: string, nodeId?: string }} */
      const ins = { at: e.at, text: e.text };
      if (e.nodeId !== undefined) ins.nodeId = e.nodeId;
      return { ...o, insights: [...o.insights, ins] };
    }
    case 'chat.asked':
    case 'chat.answered':
    case 'chat.failed': {
      const m = chatMessage(e);
      const chat = o.chat ?? [];
      if (!m || chat.some((x) => x.msgId === m.msgId)) return o.chat ? o : { ...o, chat };
      return { ...o, chat: [...chat, m] };
    }
    case 'visibility.raised': {
      if (e.to !== 'private') return o; // only ever raised; anything else is ignored
      // A private map that names no source is admin only: it stays that way, so a later source can
      // never widen who may read it.
      if (o.visibility === 'private' && !(o.privateSources || []).length) return o;
      const names = new Set(Array.isArray(o.privateSources) ? o.privateSources : []);
      for (const n of Array.isArray(e.sources) ? e.sources : []) if (typeof n === 'string' && n) names.add(n);
      return { ...o, visibility: 'private', privateSources: [...names].sort() };
    }
    default:
      return o; // unknown event types are ignored
  }
}

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
 * @returns {import('../../src/core/schema.js').Hydration|null}
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
 * @returns {import('../../src/core/schema.js').ChatMessage|null}
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

export { fold180, emptyOntology180 };

/** The reference fold of a whole stream. @param {OntoEvent[]} events @returns {Ontology} */
export const oracle = (events) => events.reduce(fold180, emptyOntology180());
