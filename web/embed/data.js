// @ts-check
// Pure reader for the map data an export carries. No DOM.

/** @typedef {any} Ontology the snapshot shape, see src/core/schema.js */

/** @param {any} v */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse the JSON text of a map. A malformed tag is an error, never an empty map.
 * @param {string|null|undefined} text
 * @returns {{ ok: true, ontology: Ontology } | { ok: false, error: string }}
 */
export function readMapData(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'No map data found in this page.' };
  /** @type {any} */
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `The map data is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  /** @param {string} what */
  const bad = (what) => ({ ok: false, error: `The map data is not a map: ${what}.` });
  if (!isPlainObject(value)) return bad('expected an object');
  if (!isPlainObject(value.nodes)) return bad('"nodes" must be an object');
  if (typeof value.root !== 'string') return bad('"root" must be a string');
  if (!Array.isArray(value.categories)) return bad('"categories" must be an array');
  if (!Array.isArray(value.edges)) return bad('"edges" must be an array');
  return { ok: true, ontology: /** @type {Ontology} */ (value) };
}
