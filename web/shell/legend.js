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
    title: families.length === 1 && family === 0 ? '' : family === 2 ? TITLES[2] : sourceMapName(ontology, family),
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

/** Shorten a map name for a legend heading: at most `max` characters, cut at a word. */
export function shortName(/** @type {string} */ label, max = 28) {
  const t = String(label || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}

/**
 * The name of the source map behind a family in a fused map: the label of the root that the
 * family's categories hang from, else the depth-1 roots (category '') in order, else "Map N".
 * @param {any} ontology @param {number} family
 */
export function sourceMapName(ontology, family) {
  const nodes = (ontology && ontology.nodes) || {};
  for (const c of (ontology && ontology.categories) || []) {
    if ((c.family || 0) !== family) continue;
    const parent = nodes[c.id] && nodes[c.id].parent;
    const root = parent ? nodes[parent] : null;
    if (root && root.category === '' && root.label) return shortName(root.label);
  }
  const roots = Object.values(nodes).filter((n) => n && n.depth === 1 && n.category === '');
  if (roots[family] && roots[family].label) return shortName(roots[family].label);
  return TITLES[family];
}
