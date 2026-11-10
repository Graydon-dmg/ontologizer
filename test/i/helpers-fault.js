// @ts-check
// Planted faults in the real server code: a copy of src/server/service.js with a few exact text
// changes, loaded from a temp folder (its relative imports point back at the real modules). Each change
// must match exactly once, so a fault that no longer applies (the code moved) fails loudly instead of
// quietly testing the unbroken server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SERVICE = fileURLToPath(new URL('../../src/server/service.js', import.meta.url));

/**
 * startService from a broken copy of service.js.
 * @param {Array<[string, string]>} changes [exact text in service.js, what it becomes]
 * @returns {Promise<typeof import('../../src/server/service.js').startService>}
 */
export async function faultyStartService(changes) {
  let src = fs.readFileSync(SERVICE, 'utf8');
  for (const [from, to] of changes) {
    const n = src.split(from).length - 1;
    if (n !== 1) throw new Error(`planted fault: expected exactly one match in service.js, found ${n}: ${from.slice(0, 80)}`);
    src = src.replace(from, () => to);
  }
  const dir = path.dirname(SERVICE);
  src = src.replace(/(from\s+')(\.{1,2}\/[^']+)(')/g, (_, a, rel, c) => `${a}${pathToFileURL(path.resolve(dir, rel)).href}${c}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-fault-'));
  const file = path.join(tmp, 'service.mjs');
  fs.writeFileSync(file, src);
  try {
    return (await import(pathToFileURL(file).href)).startService;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
