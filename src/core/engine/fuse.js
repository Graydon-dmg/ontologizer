// @ts-check
// fuse: merge two ontologies into a new draft, then find the seam between them (hybrids + bridges).
import { makeEvent } from '../events.js';
import { FUSE_SYSTEM, fusePrompt } from './prompts-g.js';

/** @typedef {import('../schema.js').Ontology} Ontology */

const REFUSAL = 'fuse takes two maps; fuse the result again to add a third';
const MAX_HYBRIDS = 8;
const MAX_BRIDGES = 20;

/** @param {string} s */
function slug(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** @param {any} v */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * @param {{ store: any, models: { fast: string, strong: string }, getClient: () => any, jsonLines: (c: AsyncIterable<string>) => AsyncIterable<any> }} ctx
 * @param {string} a  ontology id
 * @param {string} b  ontology id
 * @param {{ into?: string }} [opts]
 * @returns {Promise<string>} the new draft's id
 */
export async function fuse(ctx, a, b, opts) {
  if (arguments.length > 4 || Array.isArray(a) || Array.isArray(b) || typeof opts === 'string' || Array.isArray(opts)) {
    throw new Error(REFUSAL);
  }
  if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) throw new Error('fuse needs two map ids');
  if (a === b) throw new Error('fuse needs two different maps');
  const into = opts && typeof opts === 'object' ? str(opts.into) : '';

  const startedAt = Date.now();
  const oa = ctx.store.read(a);
  const ob = ctx.store.read(b);
  const askName = !(into && slug(into));

  /** @param {Ontology} o */
  const promptSide = (o) => ({
    root: o.root,
    name: o.name,
    nodes: Object.values(o.nodes).map((n) => ({ id: n.id, label: n.label, depth: n.depth })),
  });

  // The seam call starts first when we still need a name; otherwise structure goes out first.
  /** @type {any} */
  let stream = null;
  const startCall = () => {
    const client = ctx.getClient();
    stream = client.messages.stream({
      model: ctx.models.strong,
      max_tokens: 16000,
      system: FUSE_SYSTEM,
      messages: [{ role: 'user', content: fusePrompt({ a: promptSide(oa), b: promptSide(ob), askName }) }],
      output_config: { effort: 'medium' },
    });
    async function* text() {
      for await (const e of stream) {
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') yield e.delta.text;
      }
    }
    return ctx.jsonLines(text())[Symbol.asyncIterator]();
  };

  /** @type {AsyncIterator<any> | null} */
  let it = null;
  let root = '';
  let rootLabel = '';
  /** @type {any} */
  let pending = null; // first parsed object, when it was not a name line

  if (!askName) {
    root = slug(into);
    rootLabel = into;
  } else {
    it = startCall();
    const first = await it.next();
    const v = first.done ? null : first.value;
    const nm = v && typeof v.name === 'string' ? str(v.name) : '';
    if (nm && slug(nm)) {
      root = slug(nm);
      rootLabel = nm;
    } else {
      root = `${oa.root}-x-${ob.root}`;
      rootLabel = root;
      pending = v;
    }
  }
  if (root === oa.root || root === ob.root) root = `${root}-fusion`;

  const brief = {
    context: `Fusion of ${oa.name} and ${ob.name}`,
    subject: `${oa.brief.subject} × ${ob.brief.subject}`,
    scope: [oa.brief.scope, ob.brief.scope].filter(Boolean).join('; '),
    purpose: 'Find where the two fields meet',
    level: oa.brief.level,
  };
  const draftId = ctx.store.createDraft(brief, root);
  /** @param {string} t @param {Record<string, any>} f */
  const emit = (t, f) => ctx.store.append(draftId, makeEvent(t, f, startedAt));

  // ---- structure ----
  emit('ontology.created', { name: root, root, brief, categories: [] });
  let nextIndex = 0;
  for (const c of oa.categories) { emit('category.added', { category: { ...c, family: 0 } }); nextIndex = Math.max(nextIndex, c.index + 1); }
  for (const c of ob.categories) { emit('category.added', { category: { ...c, family: 1 } }); nextIndex = Math.max(nextIndex, c.index + 1); }
  emit('category.added', { category: { id: 'hybrids', label: 'Hybrids', index: nextIndex, family: 2 } });

  const fusedNode = (/** @type {any} */ f) => ({ summary: undefined, hook: undefined, origin: 'fuse', sources: [], article: null, status: 'done', createdBy: 'fuse', ...f });
  const clean = (/** @type {any} */ n) => Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined));

  emit('node.added', { node: clean(fusedNode({ id: root, label: rootLabel, parent: null, category: '', depth: 0 })) });
  for (const o of [oa, ob]) {
    const r = o.nodes[o.root];
    if (r) emit('node.added', { node: { ...r, sources: [...(r.sources ?? [])], parent: root, depth: 1, category: '' } });
  }
  const hybridsRoot = `${root}/hybrids`;
  emit('node.added', { node: clean(fusedNode({ id: hybridsRoot, label: 'Hybrids', parent: root, category: 'hybrids', depth: 1 })) });

  /** which map each copied node id belongs to */
  /** @type {Map<string, 'a'|'b'>} */
  const side = new Map();
  for (const [tag, o] of /** @type {const} */ ([['a', oa], ['b', ob]])) {
    for (const id of Object.keys(o.nodes)) side.set(id, tag);
    const emitted = new Set([o.root]);
    let todo = Object.values(o.nodes).filter((n) => n.id !== o.root);
    while (todo.length) {
      const rest = [];
      for (const n of todo) {
        if (n.parent === null || emitted.has(n.parent) || !o.nodes[n.parent]) {
          emit('node.added', { node: { ...n, sources: (n.sources ?? []).map((s) => ({ ...s })), depth: n.depth + 1 } });
          emitted.add(n.id);
        } else rest.push(n);
      }
      if (rest.length === todo.length) { // cycle or garbage: emit as-is rather than loop forever
        for (const n of rest) emit('node.added', { node: { ...n, depth: n.depth + 1 } });
        break;
      }
      todo = rest;
    }
    for (const e of o.edges) emit('edge.added', { edge: { ...e, id: `${o.root}:${e.id}` } });
  }

  // ---- the seam ----
  if (!it) it = startCall();

  /** @type {Map<string, string>} lower-cased hybrid label -> hybrid id */
  const hybridByLabel = new Map();
  const hybridIds = new Set();
  const pairs = new Set();
  let nHybrids = 0;
  let nBridges = 0;

  /** @param {string} id lower-cased label of a copied node or hybrid */
  const labelOf = (id) => str((oa.nodes[id] ?? ob.nodes[id])?.label ?? hybridLabel.get(id)).toLowerCase();
  /** @type {Map<string, string>} hybrid id -> label */
  const hybridLabel = new Map();

  /** @param {string} ref @returns {'a'|'b'|'h'|null} with the resolved id */
  const resolve = (ref) => {
    const r = str(ref);
    if (side.has(r)) return /** @type {any} */ ({ id: r, side: side.get(r) });
    if (hybridIds.has(r)) return /** @type {any} */ ({ id: r, side: 'h' });
    const h = hybridByLabel.get(r.toLowerCase());
    return h ? /** @type {any} */ ({ id: h, side: 'h' }) : null;
  };

  /** @param {any} obj */
  const handle = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.hybrid === 'string') {
      const label = str(obj.hybrid);
      if (!label || nHybrids >= MAX_HYBRIDS) return;
      const base = slug(label) || 'hybrid';
      let id = `${hybridsRoot}/${base}`;
      for (let k = 2; hybridIds.has(id); k++) id = `${hybridsRoot}/${base}-${k}`;
      hybridIds.add(id);
      hybridLabel.set(id, label);
      nHybrids++;
      if (!hybridByLabel.has(label.toLowerCase())) hybridByLabel.set(label.toLowerCase(), id);
      emit('node.added', { node: clean(fusedNode({
        id, label, parent: hybridsRoot, category: 'hybrids', depth: 2,
        summary: str(obj.summary) || undefined, hook: str(obj.hook) || undefined,
      })) });
      return;
    }
    if ('from' in obj && 'to' in obj) {
      if (nBridges >= MAX_BRIDGES) return;
      const why = str(obj.why);
      const f = /** @type {any} */ (resolve(obj.from));
      const t = /** @type {any} */ (resolve(obj.to));
      if (!why || !f || !t || f.id === t.id) return;
      if (labelOf(f.id) && labelOf(f.id) === labelOf(t.id)) return; // "Gunpla -> Gunpla" says nothing
      if (f.side !== 'h' && f.side === t.side) return;
      const key = `${f.id}\u0000${t.id}`;
      if (pairs.has(key)) return;
      pairs.add(key);
      nBridges++;
      emit('edge.added', { edge: { id: `bridge-${nBridges}`, from: f.id, to: t.id, type: 'bridge', why } });
    }
  };

  if (pending) handle(pending);
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    handle(r.value);
  }
  // A refusal or max_tokens stop keeps whatever streamed; errors (e.g. 401) propagate unchanged.
  if (stream && typeof stream.finalMessage === 'function') await stream.finalMessage();
  return draftId;
}
