// @ts-check
// Fold speed: `node scripts/bench-fold.js 1000 5000 10000` prints foldAll's median of 5 runs per size
// and, for sizes up to 5000, the frozen 1.8.0 oracle's time (it is quadratic: slower sizes take minutes).
import { pathToFileURL } from 'node:url';
import { foldAll } from '../src/core/events.js';
import { oracle } from '../test/j/e-oracle-fold.js';

/**
 * A map of n nodes (a root, then nodes with parents and source lists) and one edge per five nodes.
 * @param {number} n @param {number} [edgeCount]
 */
export function genStream(n, edgeCount = Math.floor(n / 5)) {
  /** @type {any[]} */
  const ev = [{ t: 'ontology.created', at: 0, name: 'Bench', root: 'n0', brief: { context: 'bench' }, categories: [{ id: 'c', label: 'C' }] }];
  for (let i = 0; i < n; i++) {
    ev.push({ t: 'node.added', at: i + 1, node: {
      id: `n${i}`, label: `Node ${i}`, parent: i ? `n${Math.floor((i - 1) / 4)}` : null, category: 'c', summary: `s${i}`, tags: ['t'],
      sources: [{ title: `src ${i}`, url: `https://example.com/${i}` }, { title: `alt ${i}`, url: `https://example.org/${i}` }],
    } });
  }
  for (let i = 0; i < edgeCount; i++) ev.push({ t: 'edge.added', at: n + 1 + i, edge: { id: `e${i}`, from: `n${i % n}`, to: `n${(i * 7 + 3) % n}`, kind: 'related' } });
  return ev;
}

/** @param {() => void} fn @returns {number} ms */
function time(fn) { const t = performance.now(); fn(); return performance.now() - t; }
/** @param {() => void} fn @param {number} [runs] @returns {number} median ms */
export function median(fn, runs = 5) {
  const ts = Array.from({ length: runs }, () => time(fn)).sort((a, b) => a - b);
  return ts[Math.floor(runs / 2)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
  for (const n of sizes.length ? sizes : [1000, 5000, 10000]) {
    const ev = genStream(n);
    const fast = median(() => { foldAll(ev); });
    const slow = n <= 5000 ? `${median(() => { oracle(ev); }, 1).toFixed(0)} ms (oracle, 1 run)` : 'skipped';
    console.log(`${String(n).padStart(6)} nodes  foldAll ${fast.toFixed(1)} ms  ${slow}`);
  }
}
