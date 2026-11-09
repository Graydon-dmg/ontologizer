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

/**
 * The collapsed nodes that hide any of these ids: every collapsed ancestor, grandparents and
 * higher included, shallowest first. Expanding them makes every match visible.
 * @param {Ontology} ontology @param {string[]} ids @param {string[]|null|undefined} collapsed
 * @returns {string[]}
 */
export function ancestorsToExpand(ontology, ids, collapsed) {
  const col = new Set(collapsed || []);
  if (!col.size) return [];
  /** @type {Set<string>} */
  const out = new Set();
  for (const id of ids) {
    const seen = new Set([id]);
    for (let p = ontology.nodes[id]?.parent; p != null && !seen.has(p); p = ontology.nodes[p]?.parent) {
      if (col.has(p)) out.add(p);
      seen.add(p);
    }
  }
  return [...out].sort((a, b) => (ontology.nodes[a]?.depth ?? 0) - (ontology.nodes[b]?.depth ?? 0) || a.localeCompare(b));
}

/** How long typing must pause before search opens collapsed branches. */
export const REVEAL_DELAY_MS = 400;

/**
 * Search's "open the branches that hide a match", paced: an expand is a saved change to the map,
 * so it is sent once the user stops typing (or presses Enter), never twice for the same node while
 * it is still waiting to land, and not at all once the page turned out unable to change the map
 * (for example a read-only token in service mode): no error notice for that, search still works.
 * No DOM; the timer and the action are passed in.
 * @param {{
 *   snapshot: () => Ontology,
 *   act: (a: { type: 'expand', nodeId: string }) => Promise<any>|any,
 *   delayMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (t: any) => void,
 * }} deps
 */
export function createReveal({ snapshot, act, delayMs = REVEAL_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** Nodes asked to open whose expand has not shown up in the snapshot yet. @type {Set<string>} */
  const asked = new Set();
  let stopped = false;
  /** @type {any} */
  let timer = null;
  /** @type {string[]} */
  let pending = [];

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  /** Open now what hides these matches. @param {string[]} ids */
  const now = (ids) => {
    cancel();
    if (stopped) return;
    const snap = snapshot();
    const collapsed = snap.view?.collapsed || [];
    // An expand that landed is no longer collapsed: forget it, so a branch the user closes again
    // can be reopened by a later search.
    for (const id of [...asked]) if (!collapsed.includes(id)) asked.delete(id);
    for (const nodeId of ancestorsToExpand(snap, ids, collapsed)) {
      if (asked.has(nodeId)) continue;
      asked.add(nodeId);
      /** @type {any} */
      let res;
      try { res = act({ type: 'expand', nodeId }); } catch { stopped = true; return; }
      Promise.resolve(res).then(
        (r) => { if (r && r.ok === false) stopped = true; },
        () => { stopped = true; },
      );
    }
  };

  return {
    /** After the user pauses typing. @param {string[]} ids */
    schedule(ids) {
      pending = ids;
      cancel();
      if (stopped || !ids.length) return;
      timer = setTimer(() => { timer = null; now(pending); }, delayMs);
    },
    now,
    cancel,
    /** True once an expand was refused: this session does not try again. */
    stopped: () => stopped,
  };
}
