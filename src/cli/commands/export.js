// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../deps.js';
import { resolveName } from '../resolve-name.js';
import { foldAll } from '../../core/events.js';
import { exportMap, FORMATS } from '../../core/export/index.js';

const BUNDLES = new URL('../../../web/dist/', import.meta.url);

/**
 * The text of the embed bundle, or a clear error when it was never built.
 * @param {boolean} threeD
 * @returns {string}
 */
export function readBundle(threeD) {
  const name = threeD ? 'embed-3d.js' : 'embed.js';
  try {
    return fs.readFileSync(new URL(name, BUNDLES), 'utf8');
  } catch {
    throw new CliError(`The embed bundle (web/dist/${name}) is missing. In a source checkout, run \`npm run build\` first.`, 1);
  }
}

/**
 * The map to export, resolved as `load` does: a saved map or draft, else a bundled fixture by name.
 * A fixture is read straight from the package (nothing is imported into the store).
 * @param {any} deps @param {string} name
 * @returns {Promise<{ id: string, ontology: import('../../core/schema.js').Ontology }>}
 */
async function findMap(deps, name) {
  const store = deps.store();
  if (store.resolve(name) === null && /^[a-z0-9][a-z0-9-]*$/.test(name)) {
    const file = new URL(`../../../fixtures/${name}.events.jsonl`, import.meta.url);
    if (fs.existsSync(file)) {
      const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { id: name, ontology: foldAll(events) };
    }
  }
  const id = await resolveName(deps, store, name);
  return { id, ontology: store.read(id) };
}

/** @param {number} bytes */
const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default {
  command: 'export <map>',
  describe: 'Export a map: a page, an embed, JSON, or a context pack for an agent',
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string', describe: 'Map name (a prefix works), or a bundled map such as demo' })
    .option('format', { type: 'string', choices: [...FORMATS], demandOption: true, describe: 'html: one offline page; embed: a fragment for any page; json: the snapshot; context: markdown for an agent' })
    .option('3d', { type: 'boolean', default: false, describe: 'html and embed only: add the 3D view (a bigger file)' })
    .option('budget', { type: 'number', default: 4000, describe: 'context only: size limit in estimated tokens' })
    .option('out', { type: 'string', describe: 'File to write (html, embed: default <map>.html / <map>.embed.html here; json, context: default stdout)' })
    .option('live-url', { type: 'string', describe: 'html and embed only: an "Open live" link to this address' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const format = /** @type {'html'|'embed'|'json'|'context'} */ (argv.format);
    const page = format === 'html' || format === 'embed';
    const threeD = Boolean(argv['3d']);
    if (threeD && !page) throw new CliError('--3d only applies to --format html or embed.', 1);
    const budget = Number(argv.budget);
    if (format === 'context' && !(Number.isInteger(budget) && budget >= 100)) throw new CliError('--budget must be a whole number of tokens, at least 100.', 1);
    const liveUrl = argv.liveUrl ?? null;
    if (liveUrl !== null) {
      if (!page) throw new CliError('--live-url only applies to --format html or embed.', 1);
      let ok = false;
      try { ok = ['http:', 'https:'].includes(new URL(String(liveUrl)).protocol); } catch { ok = false; }
      if (!ok) throw new CliError('--live-url must be an http or https address.', 1);
    }

    const { id, ontology } = await findMap(deps, String(argv.map));
    const bundle = page ? readBundle(threeD) : undefined;
    let text;
    try {
      text = exportMap(ontology, { format, bundle, budget, liveUrl });
    } catch (err) {
      throw new CliError(/** @type {Error} */ (err).message, 1);
    }

    const out = argv.out ?? (format === 'html' ? `${id}.html` : format === 'embed' ? `${id}.embed.html` : null);
    if (out === null) {
      deps.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      return;
    }
    const file = path.resolve(String(out));
    fs.writeFileSync(file, text);
    const bytes = Buffer.byteLength(text);
    const what = format === 'html' ? (threeD ? 'page with the 3D view' : 'page') : format === 'embed' ? (threeD ? 'embed with the 3D view' : 'embed') : format;
    deps.stdout.write(`Wrote the ${what} to ${file} (${size(bytes)}).\n`);
  },
};
