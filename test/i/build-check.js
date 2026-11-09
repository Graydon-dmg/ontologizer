// @ts-check
// Shared by the I4 tests: the built bundles (built on demand, so a test never assumes web/dist/
// exists), the demo map, and the checks each I4 test runs with its planted fault.
import fs from 'node:fs';
import { buildEmbed } from '../../scripts/build-embed.js';
import { foldAll } from '../../src/core/events.js';

export const ROOT = new URL('../../', import.meta.url);
export const DIST = new URL('web/dist/', ROOT);

/** @param {boolean} [threeD] @returns {Promise<string>} */
export async function bundleText(threeD = false) {
  const file = new URL(threeD ? 'embed-3d.js' : 'embed.js', DIST);
  if (!fs.existsSync(file)) await buildEmbed({ quiet: true });
  return fs.readFileSync(file, 'utf8');
}

/** @param {string} name */
export function fixtureEvents(name) {
  return fs.readFileSync(new URL(`fixtures/${name}.events.jsonl`, ROOT), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export const demo = () => foldAll(fixtureEvents('demo'));

/** What a bundle must never contain: anything that talks to a network. */
export const NETWORK = ['fetch(', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'import('];

/** @param {string} code @returns {string[]} */
export function networkProblems(code) {
  return NETWORK.filter((t) => code.includes(t)).map((t) => `bundle contains ${t}`);
}

/**
 * External URLs an html or embed export would load: any http:, https: or protocol-relative URL
 * in a src or href attribute, an import, or a CSS url(). The one allowed link is liveUrl in an
 * <a href>.
 * @param {string} html @param {{ liveUrl?: string|null }} [opts] @returns {string[]}
 */
export function externalUrlProblems(html, { liveUrl = null } = {}) {
  const URLISH = String.raw`(?:https?:)?\/\/`;
  const problems = [];
  const attr = new RegExp(String.raw`\b(src|href|srcset|action|poster|data)\s*=\s*["']?\s*(${URLISH}[^"'\s>)]*)`, 'gi');
  for (const m of html.matchAll(attr)) {
    const tagStart = html.lastIndexOf('<', m.index);
    const inAnchor = /^<a\s/i.test(html.slice(tagStart, tagStart + 3));
    const live = liveUrl !== null && m[1].toLowerCase() === 'href' && inAnchor && m[2].replace(/&amp;/g, '&') === liveUrl;
    if (!live) problems.push(`external ${m[1]}: ${m[2]}`);
  }
  const imports = new RegExp(String.raw`\bimport\b\s*(?:[\w$*{},\s]+\bfrom\b\s*)?\(?\s*["'](${URLISH}[^"']*)`, 'g');
  for (const m of html.matchAll(imports)) problems.push(`external import: ${m[1]}`);
  const atImport = new RegExp(String.raw`@import\s+["'](${URLISH}[^"']*)`, 'gi');
  for (const m of html.matchAll(atImport)) problems.push(`external @import: ${m[1]}`);
  const cssUrl = new RegExp(String.raw`url\(\s*["']?\s*(${URLISH}[^"')\s]*)`, 'gi');
  for (const m of html.matchAll(cssUrl)) problems.push(`external url(): ${m[1]}`);
  return problems;
}

/**
 * Does a format's output carry the Private mark?
 * @param {'html'|'embed'|'json'|'context'} format @param {string} text @returns {string[]}
 */
export function privateMarkProblems(format, text) {
  if (format === 'json') {
    let v = null;
    try { v = JSON.parse(text).visibility; } catch { /* reported below */ }
    return v === 'private' ? [] : ['json has no top-level "visibility": "private"'];
  }
  if (format === 'context') return /Private/.test(text.split('\n')[0]) ? [] : ['context does not start with a Private line'];
  return /<[^>]*slot="banner"[^>]*>[^<]*Private/.test(text) ? [] : [`${format} has no Private banner`];
}

/** The text of the data tag in an html page (#ontologizer-data) or an embed (.ontologizer-data). @param {string} html */
export function dataTagText(html) {
  const m = html.match(/<script type="application\/json" (?:id|class)="ontologizer-data">([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

/** Bytes over the 2D page limit. */
export const MAX_2D_HTML = 400 * 1024;
/** @param {string} html @returns {string[]} */
export function sizeProblems(html) {
  const bytes = Buffer.byteLength(html);
  return bytes < MAX_2D_HTML ? [] : [`2D html export is ${Math.round(bytes / 1024)} KB, over ${MAX_2D_HTML / 1024} KB`];
}
