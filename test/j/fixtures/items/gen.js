// @ts-check
// Deterministic item generator for tests: genItems(n, { seed, text }) -> { id, label, text? }[].

const A = ['Amber', 'Brisk', 'Cobalt', 'Delta', 'Ember', 'Fable', 'Gentle', 'Hollow', 'Iron', 'Jade', 'Keen', 'Lunar', 'Mellow', 'Noble', 'Opal', 'Quiet', 'Rapid', 'Silver', 'Tidal', 'Umber', 'Vivid', 'Woven', 'Xenon', 'Young', 'Zesty', '3D', '4K', '7th'];
const B = ['anchor', 'bridge', 'canyon', 'dynamo', 'engine', 'forest', 'garden', 'harbor', 'island', 'jungle', 'kernel', 'lantern', 'market', 'needle', 'orchard', 'pillar', 'quarry', 'ribbon', 'signal', 'tunnel', 'valley', 'window'];

/** @param {number} seed */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} n
 * @param {{ seed?: number, text?: boolean }} [opts]
 * @returns {{ id: string, label: string, text?: string }[]}
 */
export function genItems(n, { seed = 1, text = true } = {}) {
  const r = rng(seed);
  /** @param {string[]} a */
  const pick = (a) => a[Math.floor(r() * a.length)];
  const items = [];
  for (let i = 0; i < n; i++) {
    const label = `${pick(A)} ${pick(B)} ${i % 97}`;
    /** @type {{ id: string, label: string, text?: string }} */
    const it = { id: `item-${i}`, label };
    if (text) it.text = `The ${pick(B)} of ${pick(A).toLowerCase()} ${pick(B)}s, number ${i}.`;
    items.push(it);
  }
  return items;
}
