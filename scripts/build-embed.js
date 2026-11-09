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
export const ENTRIES = /** @type {const} */ ([['index.js', 'embed.js'], ['index-3d.js', 'embed-3d.js']]);

// Several exports on one page each carry the bundle; only the first one to run defines the element.
const GUARD_OPEN = 'if(!(globalThis.customElements&&customElements.get("ontologizer-map"))){';
const GUARD_CLOSE = '}';

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
    entryPoints: [path.join(ROOT, 'web', 'embed', entry)],
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
 * The packages an entry's bundle includes, by running esbuild without writing anything.
 * @param {string} entry  'index.js' or 'index-3d.js'
 * @returns {Promise<Map<string, string>>} name@version -> package dir
 */
export async function bundledPackages(entry) {
  const { build } = await import('esbuild');
  const probe = await build({ ...options(entry), write: false, metafile: true, outfile: path.join(DIST_DIR, 'probe.js') });
  return packagesOf(Object.keys(probe.metafile?.inputs ?? {}));
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

/** @param {{ outdir?: string, quiet?: boolean }} [opts] @returns {Promise<{ file: string, bytes: number }[]>} */
export async function buildEmbed({ outdir = DIST_DIR, quiet = false } = {}) {
  const { build } = await import('esbuild');
  mkdirSync(outdir, { recursive: true });
  const out = [];
  for (const [entry, name] of ENTRIES) {
    const file = path.join(outdir, name);
    // First pass: find which packages go in. Second pass: write the bundle with their licences on top.
    const licences = licenceComment(await bundledPackages(entry));
    const res = await build({
      ...options(entry),
      outfile: file,
      write: false,
      legalComments: 'none', // every licence is in the comment above, once
      banner: { js: licences + GUARD_OPEN },
      footer: { js: GUARD_CLOSE },
    });
    const code = res.outputFiles[0].text;
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
