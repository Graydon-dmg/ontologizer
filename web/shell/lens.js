// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

/** @param {Ontology} ontology @returns {{ value: string|null, label: string }[]} */
export function lensOptions(ontology) {
  return [
    { value: null, label: 'none' },
    ...Object.values(ontology.lenses || {}).map((l) => ({ value: l.id, label: l.persona || l.id })),
  ];
}

/** @param {string|null|undefined} value */
export function lensSelection(value) {
  const v = value === '' || value === 'none' || value == null ? null : value;
  return { action: { type: 'lens', value: v }, setLensArg: v };
}

/**
 * Apply a lens choice to the view and the server. 'none' calls setLens(null).
 * @param {{ setLens?: (id: string|null) => void }|null|undefined} view
 * @param {(action: any) => any} act @param {string|null|undefined} value
 */
export function chooseLens(view, act, value) {
  const s = lensSelection(value);
  view?.setLens?.(s.setLensArg);
  return act(s.action);
}

/** @param {Ontology} ontology @param {string} nodeId */
export function analogFor(ontology, nodeId) {
  const lensId = ontology.view?.lens;
  const lens = lensId ? ontology.lenses?.[lensId] : null;
  const a = lens?.analogs?.[nodeId];
  if (!lens || !a) return null;
  return { lensId: lens.id, persona: lens.persona, label: a.label, breaks: a.breaks };
}
