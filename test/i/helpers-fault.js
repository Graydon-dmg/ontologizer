// @ts-check
// Planted faults in the real code: a copy of one source module with a few exact text changes, loaded
// from a temp folder (its relative imports point back at the real modules). Each change must match
// exactly once, so a fault that no longer applies (the code moved) fails loudly instead of quietly
// testing the unbroken code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * A broken copy of a module, imported.
 * @param {string} rel the module, from the repository root (e.g. "src/server/service.js")
 * @param {Array<[string, string]>} changes [exact text in the module, what it becomes]
 * @returns {Promise<any>} the copy's exports
 */
export async function faultyModule(rel, changes) {
  const real = path.join(ROOT, rel);
  let src = fs.readFileSync(real, 'utf8');
  for (const [from, to] of changes) {
    const n = src.split(from).length - 1;
    if (n !== 1) throw new Error(`planted fault: expected exactly one match in ${rel}, found ${n}: ${from.slice(0, 80)}`);
    src = src.replace(from, () => to);
  }
  const dir = path.dirname(real);
  src = src.replace(/(from\s+')(\.{1,2}\/[^']+)(')/g, (_, a, r, c) => `${a}${pathToFileURL(path.resolve(dir, r)).href}${c}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fault-'));
  const file = path.join(tmp, `${path.basename(rel, '.js')}.mjs`);
  fs.writeFileSync(file, src);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * startService from a broken copy of src/server/service.js.
 * @param {Array<[string, string]>} changes
 * @returns {Promise<typeof import('../../src/server/service.js').startService>}
 */
export async function faultyStartService(changes) {
  return (await faultyModule('src/server/service.js', changes)).startService;
}
