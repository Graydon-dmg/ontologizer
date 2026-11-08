// @ts-check
/** OntoEvent:
 *  { t: 'ontology.created', at, name, root, brief, categories: [] }   always the first event
 *  { t: 'category.added', at, category }
 *  { t: 'node.added', at, node }
 *  { t: 'node.updated', at, id, patch }            shallow merge into the node
 *  { t: 'edge.added', at, edge }
 *  { t: 'view.changed', at, patch }                shallow merge into view (filter merges one level deeper)
 *  { t: 'lens.added', at, lens }                   lens.analogs may start empty
 *  { t: 'lens.analog', at, lensId, nodeId, label, breaks? }
 *  { t: 'job.queued'|'job.started'|'job.done'|'job.failed', at, job: { id, kind, nodeId?, error? } }
 *  { t: 'insight', at, text, nodeId? }
 *  { t: 'ontology.renamed', at, name }             written by save
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

/** Fold from emptyOntology(). @param {OntoEvent[]} events @returns {Ontology} */
export function foldAll(events) {
  let o = emptyOntology();
  for (const e of events) o = fold(o, e);
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
