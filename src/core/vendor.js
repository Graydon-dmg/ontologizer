// @ts-check
// Locate installed npm packages on disk so the web server can serve them under /vendor/<pkg>/.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * @param {string} pkg
 * @returns {string} entry file path
 */
function resolveEntry(pkg) {
  try {
    return require.resolve(pkg);
  } catch {
    // ESM-only package without a "require" condition.
    return fileURLToPath(import.meta.resolve(pkg));
  }
}

/**
 * Absolute folder of an installed package (the nearest parent of its entry whose package.json names it).
 * @param {string} pkg
 * @returns {string}
 */
export function packageDir(pkg) {
  let entry;
  try {
    entry = resolveEntry(pkg);
  } catch (err) {
    throw new Error(`Cannot find installed package "${pkg}": ${/** @type {Error} */ (err).message}`);
  }
  let dir = path.dirname(entry);
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).name === pkg) return dir;
      } catch { /* keep walking */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`Found entry ${entry} for "${pkg}" but no enclosing package.json named "${pkg}"`);
}

/**
 * Map "/vendor/<pkg>/<rest>" to an absolute file path inside the package; null if invalid or escaping.
 * @param {string} urlPath
 * @returns {string|null}
 */
export function resolveVendorPath(urlPath) {
  if (typeof urlPath !== 'string' || urlPath.includes('\0') || urlPath.includes('\\')) return null;
  const m = /^\/vendor\/([^/]+)\/(.+)$/.exec(urlPath);
  if (!m) return null;
  let pkg, rest;
  try {
    pkg = decodeURIComponent(m[1]);
    rest = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (rest.includes('\0') || rest.split('/').includes('..') || !/^[a-z0-9][a-z0-9._-]*$/i.test(pkg)) return null;
  let root;
  try {
    root = packageDir(pkg);
  } catch {
    return null;
  }
  const full = path.resolve(root, rest);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}
