// @ts-check
// `include` on the reads (export_map, get_node, get_snapshot): which extra node fields to carry.
// Epic S puts the final parseInclude here; Epic D fills in withHydration and snapshotFor.

/** The values `include` knows. */
const KNOWN = ['hydration'];

/**
 * Parse an `include` value: nothing, one name, a comma list, a JSON array string (how a GET query
 * carries an array) or an array. Returns the known values, de-duplicated.
 * @param {unknown} value @returns {string[]}
 */
export function parseInclude(value) {
  /** @type {unknown[]} */
  let list;
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('[')) {
      try { const j = JSON.parse(t); list = Array.isArray(j) ? j : [j]; } catch { throw bad(t); }
    } else list = t.split(',').map((x) => x.trim()).filter(Boolean);
  } else throw bad(value);
  const out = [];
  for (const x of list) {
    if (typeof x !== 'string' || !KNOWN.includes(x)) throw bad(x);
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/** @param {unknown} x */
function bad(x) {
  return Object.assign(new Error(`unknown include "${typeof x === 'string' ? x.slice(0, 60) : typeof x}"`), { status: 400 });
}

/** Add each node's hydration to an export object (D). @param {any} o @param {string[]} [include] */
export function withHydration(o, include) { void include; return o; }

/** A folded map for get_snapshot, with the requested extras (D); today the raw map. @param {any} o @param {string[]} [include] */
export function snapshotFor(o, include) { void include; return o; }
