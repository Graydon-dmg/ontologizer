// @ts-check
// Pure legend model (no DOM).

const TITLES = ['Map 1', 'Map 2', 'Hybrids'];

/**
 * @param {any} ontology
 * @param {typeof import('../shared/tokens.js')} tokens
 * @returns {{ family: number, title: string, items: { id: string, label: string, color: string }[] }[]}
 */
export function legendGroups(ontology, tokens) {
  const cats = (ontology && ontology.categories) || [];
  const fam = (/** @type {any} */ c) => (c.family === 1 || c.family === 2 ? c.family : 0);
  const families = [0, 1, 2].filter((f) => cats.some((c) => fam(c) === f));
  return families.map((family) => ({
    family,
    title: families.length === 1 && family === 0 ? '' : TITLES[family],
    items: cats
      .filter((c) => fam(c) === family)
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((c) => ({ id: c.id, label: c.label, color: tokens.categoryColor(c.index, family) })),
  }));
}

/** @param {any} ontology */
export function isFused(ontology) {
  return ((ontology && ontology.categories) || []).some((c) => c.family === 1 || c.family === 2);
}

/** @param {typeof import('../shared/tokens.js')} tokens */
export function fusedSwatches(tokens) {
  return { bridge: tokens.edgeStyle('bridge'), hybrid: tokens.originOutline('fuse') };
}
