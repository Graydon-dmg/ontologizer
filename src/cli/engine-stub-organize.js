// @ts-check
// Offline stand-in for organize_map: deterministic families from the items' labels (first character,
// upper-cased, digits under "0-9"; then the first two and three characters for deeper levels), with
// the events written exactly as the real engine writes them (begin + writeMap).
import { checkInput, effectiveDepth, begin, writeMap } from '../core/engine/organize.js';

/** The family key of a label at one level: its first `len` characters, upper-cased. @param {string} label @param {number} len */
function keyOf(label, len) {
  const head = label.slice(0, len).toUpperCase();
  const first = head.charAt(0);
  if (/[0-9]/.test(first)) return len === 1 ? '0-9' : `0-9${head.slice(1)}`;
  return /[A-Z]/.test(first) ? head : len === 1 ? '#' : `#${head.slice(1)}`;
}

/**
 * @param {{ store: any, id: string, input: any, emit: (t: string, fields: object) => void, actor?: any }} c
 * @returns {Promise<{ items: number, families: number, unsorted: number }>}
 */
export async function stubOrganize({ store, input, emit, actor = null }) {
  const checked = checkInput(input);
  if (!checked.ok) throw new Error(`organize: ${checked.error}`);
  const { name, items, mode } = checked.input;
  const n = items.length;
  const depth = effectiveDepth(n, checked.input.depth);
  /** @type {(t: string, fields: object) => void} */
  const out = actor ? (t, fields) => emit(t, { ...fields, actor }) : emit;

  begin(out, { name, n, mode });
  /** @type {Map<string, import('../core/engine/organize.js').Family>} */
  const families = new Map();
  /** @type {string[]} */
  const tops = [];
  /** @type {Map<string, string>} */
  const placed = new Map();
  for (const it of items) {
    /** @type {string|null} */
    let parent = null;
    for (let level = 1; level < depth; level++) {
      // Keys carry their level, so "A" at level 1 and a one-letter label's "A" at level 2 never meet.
      const label = keyOf(it.label, level);
      const key = `${level}:${parent ?? ''}:${label}`;
      if (!families.has(key)) {
        families.set(key, { key, label, parent, description: `Items starting with ${label}.`, level, children: [] });
        if (parent) /** @type {any} */ (families.get(parent)).children.push(key);
        else tops.push(key);
      }
      parent = key;
    }
    placed.set(it.id, /** @type {string} */ (parent));
  }
  const written = writeMap(out, { n, items, families, tops, placed });
  if (typeof store?.sync === 'function') await store.sync();
  return { items: n, families: written, unsorted: 0 };
}
