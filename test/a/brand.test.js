// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { BRAND } from '../../web/shared/tokens.js';

const dir = new URL('../../web/shared/brand/', import.meta.url);
const read = (/** @type {string} */ f) => readFileSync(new URL(f, dir), 'utf8');

/** Node-dot fills of a symbol SVG, in document order. @param {string} svg */
const nodeFills = (svg) => [...svg.matchAll(/<circle [^>]*r="7\.5" fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);

/** Brand-asset problems for a set of files; [] when fine. @param {(f: string) => string} get */
function checkBrand(get) {
  const problems = [];
  for (const f of ['symbol-light.svg', 'symbol-dark.svg', 'lockup-light.svg', 'lockup-dark.svg', 'favicon.svg']) {
    const s = get(f);
    if (/<script|\son[a-z]+=|href=|xlink:/i.test(s)) problems.push(`${f}: script, handler or link`);
    if (JSON.stringify(nodeFills(s)) !== JSON.stringify(BRAND.nodes)) problems.push(`${f}: node colors differ from BRAND.nodes`);
  }
  const fav = get('favicon.svg');
  if (!/@media \(prefers-color-scheme:\s*dark\)\s*\{\s*\.core\{fill:#f4f6fa\}/.test(fav)) problems.push('favicon.svg: no dark core rule');
  if (!/\.core\{fill:#171b22\}/.test(fav)) problems.push('favicon.svg: no light core default');
  return problems;
}

test('BRAND tokens: 8 node colors and both core colors', () => {
  assert.equal(BRAND.nodes.length, 8);
  assert.deepEqual(BRAND.core, { light: '#171b22', dark: '#f4f6fa' });
  assert.ok(Object.isFrozen(BRAND) && Object.isFrozen(BRAND.nodes));
});

test('brand SVGs are inert, match BRAND, and the favicon adapts to dark mode', () => {
  assert.deepEqual(checkBrand(read), []);
});

test('planted fault: a favicon without the dark rule, or with a script, is caught', () => {
  const bad = (/** @type {string} */ f) =>
    f === 'favicon.svg' ? read(f).replace(/@media[^}]*\}\}/, '').replace('</svg>', '<script>x()</script></svg>') : read(f);
  const p = checkBrand(bad);
  assert.ok(p.includes('favicon.svg: no dark core rule'));
  assert.ok(p.includes('favicon.svg: script, handler or link'));
});

test('PNG fallbacks exist at their sizes', () => {
  /** @type {[string, number][]} */
  const want = [['favicon-16.png', 16], ['favicon-32.png', 32], ['apple-touch-icon.png', 180]];
  for (const [f, px] of want) {
    const b = readFileSync(new URL(f, dir));
    assert.equal(b.readUInt32BE(16), px, f); assert.equal(b.readUInt32BE(20), px, f);
  }
  assert.ok(existsSync(new URL('../../docs/brand/social-preview.png', import.meta.url)));
});
