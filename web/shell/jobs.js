// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

const ORDER = { running: 0, queued: 1, failed: 2, done: 3 };

/**
 * @param {Ontology} ontology
 * @returns {{ id: string, kind: string, nodeId?: string, label: string, state: string, error?: string }[]}
 */
export function jobRows(ontology) {
  return Object.values(ontology.jobs)
    .map((j, i) => ({
      i,
      row: {
        id: j.id,
        kind: j.kind,
        nodeId: j.nodeId,
        label: (j.nodeId && ontology.nodes[j.nodeId] && ontology.nodes[j.nodeId].label) || '',
        state: j.state,
        error: j.error,
      },
    }))
    .sort((a, b) => (ORDER[a.row.state] ?? 4) - (ORDER[b.row.state] ?? 4) || a.i - b.i)
    .map((x) => x.row);
}
