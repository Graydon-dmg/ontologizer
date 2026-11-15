// @ts-check
// `include` on the reads (export_map, get_node, get_snapshot): which extra node fields to carry.
// Without include=hydration every output is byte-identical to 1.8.0, even for a hydrated map.

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

/**
 * A copy of o whose nodes carry no `hydration` key: a new top level and `nodes`, every node with
 * hydration copied without it (its other keys in order), everything else shared. o itself when no
 * node has hydration (no copy, byte-identical). Never mutates o: the fold result is live.
 * @param {any} o @returns {any}
 */
export function stripHydration(o) {
  const nodes = o && o.nodes;
  if (!nodes || typeof nodes !== 'object') return o;
  let any = false;
  for (const k in nodes) if (Object.hasOwn(nodes, k) && hasHydration(nodes[k])) { any = true; break; }
  if (!any) return o;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, n] of Object.entries(nodes)) {
    let v = n;
    if (hasHydration(n)) { const { hydration, ...rest } = n; void hydration; v = rest; }
    // a literal keeps `__proto__` an own key, as the fold does
    Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
  }
  return { ...o, nodes: out };
}

/** @param {any} n */
const hasHydration = (n) => Boolean(n) && typeof n === 'object' && Object.hasOwn(n, 'hydration');

/** The JSON export's map: hydration kept only when include has 'hydration'. @param {any} o @param {string[]} [include] */
export function withHydration(o, include = []) {
  return include.includes('hydration') ? o : stripHydration(o);
}

/** The snapshot: the same rule as the JSON export. @param {any} o @param {string[]} [include] */
export function snapshotFor(o, include = []) {
  return include.includes('hydration') ? o : stripHydration(o);
}
