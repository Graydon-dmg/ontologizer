#!/usr/bin/env node
// @ts-check
// Builds the embed bundles the exports inline: web/dist/embed.js (2D) and web/dist/embed-3d.js
// (2D and 3D), from web/embed/. Run by `npm run build`, and first by `check`, `check:i`, `dev` and
// `prepack`. The live page never uses these files: it runs from source with its import map.
//
// The bundles copy third-party code (d3, and three in the 3D one) into every exported page, so each
// bundle starts with a comment carrying the licence text of every package it includes.
import { mkdirSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST_DIR = path.join(ROOT, 'web', 'dist');
// Each bundle is one or more parts, each its own esbuild build, written one after the other. The 3D
// bundle is the 2D part (graph view and element) followed by the 3D add-on (the 3D view alone).
export const ENTRIES = /** @type {const} */ ([[['index.js'], 'embed.js'], [['index.js', 'index-3d.js'], 'embed-3d.js']]);

// Several exports on one page each carry a bundle. A part runs only if the page does not have it
// yet: the first 2D part defines the element and the 2D view, the first 3D add-on the 3D view, in
// either order (web/embed/registry.js holds the views every bundle shares).
/** @type {Record<string, { tag: string, views: string[] }>} entry -> the element it defines, the views it adds */
const PARTS = {
  'index.js': { tag: 'ontologizer-map', views: ['graph-2d'] },
  'index-3d.js': { tag: 'onto-sky', views: ['sky-3d'] },
};
/** @param {string} tag */
export const guardOpen = (tag) => `if(!(globalThis.customElements&&customElements.get(${JSON.stringify(tag)}))){`;
const GUARD_CLOSE = '}';

/**
 * Runs first, always: marks the <ontologizer-map> just before this <script> (how both export
 * formats are laid out) with the views its bundle brings, unless it already says. That is how one
 * shared element knows which maps on a page were exported with 3D.
 * @param {string[]} views
 */
export function markExport(views) {
  return `(()=>{const s=typeof document<"u"?document.currentScript:null,e=s&&s.previousElementSibling;`
    + `if(e&&e.localName==="ontologizer-map"&&!e.hasAttribute("data-views"))e.setAttribute("data-views",${JSON.stringify(views.join(' '))})})();\n`;
}

/** @param {string} dir @returns {string|null} */
export function licenceText(dir) {
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  return name ? readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim() : null;
}

/**
 * The packages a bundle includes, from esbuild's metafile inputs (paths relative to ROOT).
 * @param {string[]} inputs
 * @returns {Map<string, string>} name@version -> package dir
 */
export function packagesOf(inputs) {
  /** @type {Map<string, string>} */
  const pkgs = new Map();
  for (const file of inputs) {
    const m = file.replace(/\\/g, '/').match(/^(.*?node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (!m) continue;
    const dir = path.join(ROOT, m[1]);
    const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkgs.set(`${meta.name}@${meta.version}`, dir);
  }
  return pkgs;
}

/** esbuild options shared by the probe and the real build. @param {string} entry */
function options(entry) {
  return {
    entryPoints: [path.resolve(ROOT, 'web', 'embed', entry)], // an absolute entry is used as is (tests)
    bundle: true,
    format: /** @type {const} */ ('iife'),
    minify: true,
    target: 'es2022',
    platform: /** @type {const} */ ('browser'),
    absWorkingDir: ROOT,
    logLevel: /** @type {const} */ ('error'),
  };
}

/**
 * The packages a bundle includes, by running esbuild on each of its parts without writing anything.
 * @param {string|readonly string[]} entries  a part ('index.js', 'index-3d.js') or a bundle's parts
 * @returns {Promise<Map<string, string>>} name@version -> package dir
 */
export async function bundledPackages(entries) {
  const { build } = await import('esbuild');
  /** @type {Map<string, string>} */
  const all = new Map();
  for (const entry of typeof entries === 'string' ? [entries] : entries) {
    const probe = await build({ ...options(entry), write: false, metafile: true, outfile: path.join(DIST_DIR, 'probe.js') });
    for (const [id, dir] of packagesOf(Object.keys(probe.metafile?.inputs ?? {}))) all.set(id, dir);
  }
  return all;
}

/**
 * The licence comment for a bundle: Ontologizer's licence, then the full licence text (with its
 * copyright line) of every package the bundle includes; identical texts are written once.
 * @param {Map<string, string>} pkgs  name@version -> package dir
 * @returns {string}
 */
export function licenceComment(pkgs) {
  /** @type {Map<string, string[]>} licence text -> packages */
  const byText = new Map();
  for (const [id, dir] of [...pkgs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = licenceText(dir) ?? '(no licence file in the package)';
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text)?.push(id);
  }
  const own = licenceText(ROOT) ?? '';
  const parts = [`Ontologizer embed bundle.\n\n${own}`];
  for (const [text, ids] of byText) parts.push(`Includes ${ids.join(', ')}:\n\n${text}`);
  const body = parts.join('\n\n----\n\n').replace(/\*\//g, '* /');
  return `/*!\n${body}\n*/\n`;
}

/**
 * Inside a classic <script>, `<!--` followed later by `<script` puts the HTML parser in its
 * "double escaped" state, and the real </script> then no longer ends the element. Rewriting either
 * in minified code is not always safe (in a regular expression `\s` would change meaning), so a
 * bundle that contains one is refused instead.
 * @param {string} code @returns {string[]} what was found
 */
export function inlineHazards(code) {
  return ['<!--', '<script'].filter((t) => code.toLowerCase().includes(t));
}

/**
 * @param {{ outdir?: string, quiet?: boolean, entries?: ReadonlyArray<readonly [string|readonly string[], string]> }} [opts]
 *   entries: [part(s) under web/embed/ (or absolute paths), output file name]; tests only. A part
 *   not in PARTS is guarded like the 2D one and marks nothing.
 * @returns {Promise<{ file: string, bytes: number }[]>}
 */
export async function buildEmbed({ outdir = DIST_DIR, quiet = false, entries = ENTRIES } = {}) {
  const { build } = await import('esbuild');
  mkdirSync(outdir, { recursive: true });
  const out = [];
  for (const [entry, name] of entries) {
    const file = path.join(outdir, name);
    const parts = typeof entry === 'string' ? [entry] : entry;
    // First pass: find which packages go in. Second pass: write the bundle with their licences on top.
    const licences = licenceComment(await bundledPackages(parts));
    const views = parts.flatMap((p) => PARTS[p]?.views ?? []);
    let code = licences + (views.length ? markExport(views) : '');
    for (const part of parts) {
      const res = await build({
        ...options(part),
        outfile: file,
        write: false,
        legalComments: 'none', // every licence is in the comment above, once
        banner: { js: guardOpen(PARTS[part]?.tag ?? 'ontologizer-map') },
        footer: { js: GUARD_CLOSE },
      });
      code += res.outputFiles[0].text;
    }
    const hazards = inlineHazards(code);
    if (hazards.length) {
      throw new Error(`${name} contains ${hazards.map((h) => `"${h}"`).join(' and ')}, which would break the <script> it is inlined in (a dependency update?). Find where it comes from and avoid it; the bundle was not written.`);
    }
    // Atomic, and only when it changed: tests (and `npm pack`, which runs this) may read it meanwhile.
    if (!existsSync(file) || readFileSync(file, 'utf8') !== code) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, code);
      renameSync(tmp, file);
    }
    out.push({ file, bytes: statSync(file).size });
  }
  if (!quiet) {
    // stderr: `npm pack --json` runs this as prepack and its stdout must stay pure JSON.
    for (const o of out) process.stderr.write(`built ${path.relative(ROOT, o.file)} (${Math.round(o.bytes / 1024)} KB)\n`);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildEmbed().catch((err) => {
    console.error(`build-embed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
