// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../deps.js';
import { resolveName } from '../resolve-name.js';
import { foldAll } from '../../core/events.js';
import { exportMap, obsidianVault, FORMATS, FOLDER_FORMATS } from '../../core/export/index.js';
import { categoryColor } from '../../../web/shared/tokens.js';

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

/**
 * Writes the map's vault folder into `outDir`: `<outDir>/<Map name>/`, one note per node, and
 * `.obsidian/graph.json` (the category colours) only when the folder is new and `outDir` is not
 * itself a vault. Refuses an existing folder unless `force`; with `force` it rewrites its own notes
 * and keeps everything else. Every path is checked to stay inside the folder, and nothing is
 * written through a symbolic link.
 * @param {any} deps @param {import('../../core/schema.js').Ontology} ontology @param {string} outDir @param {boolean} force
 */
function writeVault(deps, ontology, outDir, force) {
  let vault;
  try { vault = obsidianVault(ontology, { colorOf: categoryColor }); } catch (err) { throw new CliError(/** @type {Error} */ (err).message, 1); }
  const out = path.resolve(outDir);
  if (fs.existsSync(out) && !fs.statSync(out).isDirectory()) throw new CliError(`--out ${out} is a file: give a folder to write the map's folder into.`, 1);
  const target = path.join(out, vault.folder);
  /** @param {string} p */
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const exists = fs.existsSync(target) || isLink(target);
  if (exists && !force) throw new CliError(`${target} already exists: pass --force to write into it (its other files are kept), or choose another --out.`, 1);
  if (isLink(target) || (exists && !fs.statSync(target).isDirectory())) throw new CliError(`${target} is not a plain folder: refusing to write into it.`, 1);
  /** @param {string} rel */
  const inside = (rel) => {
    const file = path.resolve(target, rel);
    const r = path.relative(target, file);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new CliError(`Refusing to write outside ${target}: ${rel}`, 1);
    return file;
  };
  const notes = vault.notes.map((n) => ({ file: inside(n.path), text: n.text }));
  for (const n of notes) if (isLink(n.file)) throw new CliError(`${n.file} is a symbolic link: refusing to write through it.`, 1);
  // Colours only for a fresh vault: never over an existing .obsidian, and not inside a vault (dropping
  // the folder into one), where Obsidian reads the vault's own settings.
  const config = !exists && !fs.existsSync(path.join(out, '.obsidian'));
  fs.mkdirSync(target, { recursive: true });
  for (const n of notes) fs.writeFileSync(n.file, n.text, { flag: force ? 'w' : 'wx' });
  if (config) {
    fs.mkdirSync(path.join(target, '.obsidian'));
    for (const c of vault.config) fs.writeFileSync(inside(c.path), c.text, { flag: 'wx' });
  }
  const colours = config ? ', with the category colours in .obsidian/graph.json' : '';
  deps.stdout.write(`Wrote ${notes.length} notes for Obsidian to ${target}${path.sep} (start at ${vault.index}${colours}).\nOpen the folder in Obsidian as a vault, or drop it into an existing vault.\n`);
}

/** @param {number} bytes */
const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default {
  command: 'export <map>',
  describe: 'Export a map: a page, an embed, JSON, a context pack for an agent, or an Obsidian vault',
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string', describe: 'Map name (a prefix works), or a bundled map such as demo' })
    .option('format', { type: 'string', choices: [...FORMATS, ...FOLDER_FORMATS], demandOption: true, describe: 'html: one offline page; embed: a fragment for any page; json: the snapshot; context: markdown for an agent; obsidian: a folder of linked notes' })
    .option('3d', { type: 'boolean', default: false, describe: 'html and embed only: add the 3D view (a bigger file)' })
    .option('budget', { type: 'number', default: 4000, describe: 'context only: size limit in estimated tokens' })
    .option('out', { type: 'string', describe: 'File to write (html, embed: default <map>.html / <map>.embed.html here; json, context: default stdout). obsidian: the folder to write the map\'s folder into (default: here)' })
    .option('force', { type: 'boolean', default: false, describe: 'obsidian only: write into the map\'s folder even though it exists (its other files are kept)' })
    .option('live-url', { type: 'string', describe: 'html and embed only: an "Open live" link to this address' })
    .option('include-chat', { type: 'boolean', default: false, describe: 'json only: keep the map\'s chat (left out by default)' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const format = /** @type {'html'|'embed'|'json'|'context'|'obsidian'} */ (argv.format);
    if (argv.force && format !== 'obsidian') throw new CliError('--force only applies to --format obsidian.', 1);
    const page = format === 'html' || format === 'embed';
    const threeD = Boolean(argv['3d']);
    if (threeD && !page) throw new CliError('--3d only applies to --format html or embed.', 1);
    const budget = Number(argv.budget);
    if (format === 'context' && !(Number.isInteger(budget) && budget >= 100)) throw new CliError('--budget must be a whole number of tokens, at least 100.', 1);
    const includeChat = Boolean(argv.includeChat);
    if (includeChat && format !== 'json') throw new CliError('--include-chat only applies to --format json.', 1);
    const liveUrl = argv.liveUrl ?? null;
    if (liveUrl !== null) {
      if (!page) throw new CliError('--live-url only applies to --format html or embed.', 1);
      let ok = false;
      try { ok = ['http:', 'https:'].includes(new URL(String(liveUrl)).protocol); } catch { ok = false; }
      if (!ok) throw new CliError('--live-url must be an http or https address.', 1);
    }

    const { id, ontology } = await findMap(deps, String(argv.map));
    if (format === 'obsidian') {
      writeVault(deps, ontology, String(argv.out ?? '.'), Boolean(argv.force));
      return;
    }
    const bundle = page ? readBundle(threeD) : undefined;
    let text;
    try {
      text = exportMap(ontology, { format, bundle, budget, liveUrl, includeChat });
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
