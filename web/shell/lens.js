// @ts-check
/** @typedef {import('../../src/core/schema.js').Ontology} Ontology */

/** @param {Ontology} ontology @returns {{ value: string|null, label: string }[]} */
export function lensOptions(ontology) {
  return [
    { value: null, label: 'None' },
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

/**
 * The action that asks the server for a new Rosetta lens, or null for empty input.
 * @param {string} persona
 * @returns {{ type: 'rosetta', persona: string }|null}
 */
export function newLensAction(persona) {
  const p = String(persona ?? '').trim().replace(/\s+/g, ' ');
  if (!p) return null;
  return { type: 'rosetta', persona: p.slice(0, 120) };
}

/**
 * New-lens requests from this page: post the rosetta action, remember the persona for the jobs
 * tray, and select the lens as soon as it exists so its labels fill in live.
 * @param {{ act: (a: any) => Promise<any>, snapshot: () => any, select: (lensId: string) => void,
 *           notice?: (text: string) => void }} o
 */
export function createLensRequests({ act, snapshot, select, notice = () => {} }) {
  /** @type {Map<string, string>} jobId -> persona */
  const personas = new Map();
  /** @type {{ persona: string, lensId: string|null }[]} */
  const waiting = [];
  const trySelect = () => {
    const lenses = snapshot().lenses || {};
    for (let i = waiting.length - 1; i >= 0; i--) {
      const w = waiting[i];
      const hit = w.lensId ? lenses[w.lensId]
        : Object.values(lenses).find((l) => String(l.persona || '').trim().toLowerCase() === w.persona.toLowerCase());
      if (hit) { waiting.splice(i, 1); select(hit.id); }
    }
  };
  return {
    personaForJob: (/** @type {string} */ jobId) => personas.get(jobId),
    /**
     * @param {string} persona
     * @returns {Promise<{ sent: boolean, ok?: boolean, error?: string }>}
     */
    async create(persona) {
      const action = newLensAction(persona);
      if (!action) return { sent: false };
      const w = { persona: action.persona, lensId: /** @type {string|null} */ (null) };
      waiting.push(w);
      notice(`Building lens: ${action.persona}`);
      let r;
      try { r = await act(action); } catch (err) { r = { ok: false, error: String(err) }; }
      if (!r || r.ok === false) {
        waiting.splice(waiting.indexOf(w), 1);
        return { sent: true, ok: false, error: (r && r.error) || 'the server refused' };
      }
      if (r.jobId) personas.set(r.jobId, action.persona);
      if (r.lensId) w.lensId = r.lensId;
      trySelect();
      return { sent: true, ok: true };
    },
    /** Call on every event: selects a waiting lens once its lens.added has arrived. @param {any} event */
    onEvent(event) { if (event && event.t === 'lens.added' && waiting.length) trySelect(); },
  };
}
