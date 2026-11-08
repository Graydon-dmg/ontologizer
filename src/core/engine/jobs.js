// @ts-check
// The three click-driven jobs: research (new children), explain (an article) and sources.
// Each reads the map, makes one model call, and writes events. Errors propagate; the queue fails the job.
import { researchContextPrompt, researchGeneralPrompt, explainPrompt, sourcesPrompt } from './prompts.js';
import { childId, labelPath } from './ids.js';

const MAX_NEW = 10;
const MAX_LABEL = 80;
const MAX_SOURCES = 8;

/** @param {any} ectx @param {string} nodeId */
function load(ectx, nodeId) {
  const o = ectx.store.read(ectx.id);
  const node = o.nodes[nodeId];
  if (!node) throw new Error(`no node "${nodeId}"`);
  return { o, node, path: labelPath(o.nodes, nodeId) };
}

/** Existing sources plus new ones, deduped by url, capped. @param {any[]} have @param {any[]} add */
function mergeSources(have, add) {
  /** @type {Map<string, any>} */ const m = new Map();
  for (const s of [...(have ?? []), ...add]) if (s && !m.has(s.url)) m.set(s.url, s);
  return [...m.values()].slice(0, MAX_SOURCES);
}

/** @param {any} ectx @param {string} nodeId @param {'context'|'general'} mode */
export async function research(ectx, nodeId, mode) {
  const { o, node, path } = load(ectx, nodeId);
  const existing = Object.values(o.nodes).filter((n) => n.parent === nodeId).map((n) => n.label);
  const { system, prompt } = mode === 'general'
    ? researchGeneralPrompt(node.label, existing)
    : researchContextPrompt(o.brief, path, existing);

  const seen = new Set(existing.map((l) => l.toLowerCase()));
  const taken = new Set(Object.keys(o.nodes));
  let added = 0;
  let newCategories = 0;

  const result = await ectx.call({ model: ectx.models.strong, effort: 'medium', system, prompt }, (/** @type {any} */ obj) => {
    if (added >= MAX_NEW || !obj || typeof obj.label !== 'string') return;
    const label = obj.label.trim();
    if (!label || label.length > MAX_LABEL || seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    const id = childId(nodeId, label, taken);
    taken.add(id);
    const isRoot = node.depth === 0;
    if (isRoot) {
      ectx.emit('category.added', { category: { id, label, index: o.categories.length + newCategories, family: 0 } });
      newCategories++;
    }
    ectx.emit('node.added', {
      node: {
        id, label, parent: nodeId, category: isRoot ? id : node.category, depth: node.depth + 1,
        summary: typeof obj.summary === 'string' ? obj.summary : '',
        hook: typeof obj.hook === 'string' ? obj.hook : '',
        origin: mode === 'general' ? 'general' : 'context',
        sources: [], article: null, status: 'done', createdBy: 'research',
      },
    });
    added++;
  });

  if (added === 0 && result.stopReason !== 'max_tokens') throw new Error('research: the model returned nothing new');
}

/** @param {any} ectx @param {string} nodeId */
export async function explain(ectx, nodeId) {
  const { o, node, path } = load(ectx, nodeId);
  const { system, prompt } = explainPrompt(o.brief, path);
  /** @type {any} */ let found = null;
  const result = await ectx.call(
    { model: ectx.models.strong, effort: 'medium', system, prompt, webSearch: true },
    (/** @type {any} */ obj) => { if (!found && obj && typeof obj.summary === 'string') found = obj; });
  if (!found) throw new Error('explain: the model returned no article');

  const strings = (/** @type {any} */ v, /** @type {number} */ max) =>
    (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []).slice(0, max);
  const article = {
    summary: found.summary,
    keyFacts: strings(found.keyFacts, 8),
    whyItMatters: typeof found.whyItMatters === 'string' ? found.whyItMatters : '',
    seeAlso: strings(found.seeAlso, 6),
    sources: result.sources.slice(0, 6),
  };
  ectx.emit('node.updated', { id: nodeId, patch: { article, sources: mergeSources(node.sources, article.sources) } });
}

/** @param {any} ectx @param {string} nodeId */
export async function sources(ectx, nodeId) {
  const { o, node, path } = load(ectx, nodeId);
  const { system, prompt } = sourcesPrompt(o.brief, path);
  /** @type {any[]} */ const picks = [];
  const result = await ectx.call(
    { model: ectx.models.strong, effort: 'medium', system, prompt, webSearch: true },
    (/** @type {any} */ obj) => { if (obj && typeof obj.url === 'string') picks.push(obj); });

  const found = new Set(result.sources.map((/** @type {any} */ s) => s.url));
  /** @type {{ title: string, url: string }[]} */ const chosen = [];
  const has = (/** @type {string} */ u) => chosen.some((c) => c.url === u);
  for (const p of picks) {
    if (found.has(p.url) && !has(p.url)) chosen.push({ title: typeof p.title === 'string' ? p.title : p.url, url: p.url });
  }
  if (chosen.length < 3) {
    for (const s of result.sources) {
      if (chosen.length >= 5) break;
      if (!has(s.url)) chosen.push(s);
    }
  }
  if (!chosen.length) throw new Error('sources: no sources found');
  ectx.emit('node.updated', { id: nodeId, patch: { sources: mergeSources(node.sources, chosen) } });
}
