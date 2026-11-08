// @ts-check
// Labels -> ids. id = parent id + "/" + slug(label); a duplicate id gets "-2", "-3", ...

/** "Plastic Cement" -> "plastic-cement". Never empty. @param {string} label */
export function slug(label) {
  const s = String(label ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/g, '');
  return s || 'node';
}

/**
 * A fresh id under parentId for this label, unique against `taken` (anything with .has(id)).
 * @param {string|null} parentId  null for the root
 * @param {string} label
 * @param {{ has: (id: string) => boolean }} taken
 */
export function childId(parentId, label, taken) {
  const base = parentId ? `${parentId}/${slug(label)}` : slug(label);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Normalise a label or a label path for matching: case, spacing, separators. @param {string} s */
export function norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s*(>|›|\/)\s*/g, ' > ').replace(/\s+/g, ' ').trim();
}

/**
 * Find a node from what the model wrote: a full label path ("Tools > Adhesives"), a path that
 * starts below the root, or a bare label when it is unique. Returns the id or null.
 * @param {Record<string, { id: string, label: string, parent: string|null }>} nodes
 * @param {string} text
 */
export function findByLabelPath(nodes, text) {
  const want = norm(text);
  if (!want) return null;
  /** @type {Map<string, string>} */ const byPath = new Map();
  /** @type {Map<string, string[]>} */ const byLabel = new Map();
  for (const n of Object.values(nodes)) {
    const p = labelPath(nodes, n.id);
    const full = norm(p.join(' > '));
    byPath.set(full, n.id);
    if (p.length > 1) byPath.set(norm(p.slice(1).join(' > ')), n.id);   // without the root
    const l = norm(n.label);
    byLabel.set(l, [...(byLabel.get(l) ?? []), n.id]);
  }
  if (byPath.has(want)) return /** @type {string} */ (byPath.get(want));
  const last = want.split(' > ').pop() ?? '';
  const hits = byLabel.get(last) ?? [];
  return hits.length === 1 ? hits[0] : null;
}

/** Labels from the root down to this node. @param {Record<string, any>} nodes @param {string} id */
export function labelPath(nodes, id) {
  /** @type {string[]} */ const out = [];
  const seen = new Set();
  for (let n = nodes[id]; n && !seen.has(n.id); n = n.parent ? nodes[n.parent] : undefined) {
    seen.add(n.id);
    out.unshift(n.label);
  }
  return out;
}
