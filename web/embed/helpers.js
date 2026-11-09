// @ts-check
// Pure helpers for the embedded map: search, safe links, the details model. No DOM.
import { ancestorsToExpand } from '../shell/search.js';

/** @typedef {any} Ontology the snapshot shape, see src/core/schema.js */

/**
 * Node ids whose label (then summary) contains the query, case-insensitive; label matches first.
 * @param {Ontology} ontology
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]}
 */
export function searchNodes(ontology, query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  /** @type {string[]} */
  const byLabel = [];
  /** @type {string[]} */
  const bySummary = [];
  for (const n of Object.values(ontology.nodes || {})) {
    if (String(n.label || '').toLowerCase().includes(q)) byLabel.push(n.id);
    else if (String(n.summary || '').toLowerCase().includes(q)) bySummary.push(n.id);
  }
  return [...byLabel, ...bySummary].slice(0, Math.max(0, limit));
}

/**
 * The url when it is an ordinary web link, else null (blocks script and data links).
 * @param {unknown} url
 * @returns {string|null}
 */
export function safeHref(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {Ontology} ontology
 * @param {string} id
 */
export function nodeDetails(ontology, id) {
  const n = ontology.nodes && ontology.nodes[id];
  if (!n) return null;
  const catRow = Array.isArray(ontology.categories) ? ontology.categories.find((/** @type {any} */ c) => c.id === n.category) : null;
  const cat = catRow ? String(catRow.label || '') : (n.category && ontology.nodes[n.category] ? ontology.nodes[n.category].label : '');
  const a = n.article || null;
  /** @type {{ title: string, href: string|null }[]} */
  const sources = [];
  const seen = new Set();
  for (const s of [...(n.sources || []), ...(a && a.sources ? a.sources : [])]) {
    if (!s) continue;
    const key = String(s.url || '');
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title: String(s.title || s.url || ''), href: safeHref(s.url) });
  }
  const childCount = Object.values(ontology.nodes).filter((x) => x.parent === id).length;
  const collapsed = !!(ontology.view && Array.isArray(ontology.view.collapsed) && ontology.view.collapsed.includes(id));
  return {
    id: n.id,
    label: n.label,
    category: cat,
    summary: n.summary || '',
    article: a ? { summary: a.summary || '', keyFacts: Array.isArray(a.keyFacts) ? a.keyFacts : [], whyItMatters: a.whyItMatters || '' } : null,
    sources,
    childCount,
    collapsed,
  };
}

/**
 * A new array with the id added, or removed when present. Never mutates.
 * @param {string[]} collapsed
 * @param {string} id
 * @returns {string[]}
 */
export function toggleCollapsed(collapsed, id) {
  const list = Array.isArray(collapsed) ? collapsed : [];
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * The view patch that opens the collapsed branches holding any of these nodes, or null when none
 * is hidden. A search uses it so its matches are drawn where they are highlighted.
 * @param {Ontology} ontology @param {string[]} ids
 * @returns {{ collapsed: string[] }|null}
 */
export function revealPatch(ontology, ids) {
  const collapsed = (ontology.view && Array.isArray(ontology.view.collapsed)) ? ontology.view.collapsed : [];
  const open = ancestorsToExpand(ontology, ids, collapsed);
  return open.length ? { collapsed: collapsed.filter((/** @type {string} */ c) => !open.includes(c)) } : null;
}

/**
 * Whether the details panel must go below the top bar: true when, placed at the right edge, it
 * would reach over the bar (so it would cover the search box).
 * @param {{ hostWidth: number, barWidth: number, panelWidth: number, margin: number }} o
 */
export function panelBelowBar({ hostWidth, barWidth, panelWidth, margin }) {
  return hostWidth - margin - panelWidth < margin + barWidth + margin;
}
