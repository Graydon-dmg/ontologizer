// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

/**
 * @param {Ontology} ontology @param {string} nodeId
 * @returns {{ node: any, article: any, researching: boolean,
 *   analog: { lensId: string, persona: string, label: string, breaks?: string }|null,
 *   seeAlso: { id: string, label: string }[], sources: { title: string, url: string }[] }|null}
 */
export function explainModel(ontology, nodeId) {
  const node = ontology.nodes[nodeId];
  if (!node) return null;
  const article = node.article || null;
  const researching = Object.values(ontology.jobs).some(
    (j) => j.kind === 'explain' && j.nodeId === nodeId && (j.state === 'queued' || j.state === 'running'),
  );
  let analog = null;
  const lensId = ontology.view.lens;
  const lens = lensId ? ontology.lenses[lensId] : null;
  const a = lens && lens.analogs ? lens.analogs[nodeId] : null;
  if (lens && a) analog = { lensId: lens.id, persona: lens.persona, label: a.label, breaks: a.breaks };
  /** @type {{ id: string, label: string }[]} */
  const seeAlso = [];
  const all = Object.values(ontology.nodes);
  for (const ref of (article && article.seeAlso) || []) {
    const hit = ontology.nodes[ref] || all.find((n) => n.label.toLowerCase() === String(ref).toLowerCase());
    if (hit && !seeAlso.some((s) => s.id === hit.id)) seeAlso.push({ id: hit.id, label: hit.label });
  }
  const sources = (article && article.sources && article.sources.length ? article.sources : node.sources) || [];
  return { node, article, researching, analog, seeAlso, sources };
}
