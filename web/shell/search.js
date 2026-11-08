// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

/**
 * Type-ahead search over node labels only (never ids).
 * @param {Ontology} ontology @param {string} query @param {number} [limit]
 * @returns {string[]}
 */
export function searchNodes(ontology, query, limit = 20) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  /** @type {{ id: string, rank: number, depth: number, label: string }[]} */
  const hits = [];
  for (const n of Object.values(ontology.nodes)) {
    const label = String(n.label ?? '').toLowerCase();
    let rank;
    if (label.startsWith(q)) rank = 0;
    else if (label.split(/[^\p{L}\p{N}]+/u).some((w) => w && w.startsWith(q))) rank = 1;
    else if (label.includes(q)) rank = 2;
    else continue;
    hits.push({ id: n.id, rank, depth: n.depth, label });
  }
  hits.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.label.localeCompare(b.label));
  return hits.slice(0, limit).map((h) => h.id);
}
