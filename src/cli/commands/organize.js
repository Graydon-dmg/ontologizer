// @ts-check
// `ontologizer organize <items> --name <name>`: organise a supplied list of items into a map with the
// local engine (no browser). Every item becomes exactly one leaf with its own id. Refuses while a
// server runs on the home: it holds its own copy of the maps and would split from the log.
import fs from 'node:fs';
import { CliError } from '../deps.js';
import { openStore } from '../../core/store.js';
import { engineFor } from '../serve.js';
import { runningServer } from '../served.js';
import { checkInput } from '../../core/engine/organize.js';

export default {
  command: 'organize <items>',
  describe: 'Organise a list of items (a JSON file, or - for stdin) into a map: every item becomes one leaf',
  builder: (/** @type {any} */ y) => y
    .positional('items', { type: 'string', describe: 'A JSON file (or - for stdin): an array of { id, label, text? }, or { "items": [...] }' })
    .option('name', { type: 'string', demandOption: true, describe: 'The map\'s display name, 1 to 120 characters' })
    .option('depth', { type: 'number', default: 3, choices: [2, 3, 4], describe: 'Levels below the root, leaves included' })
    .option('human', { type: 'boolean', default: false, describe: 'Human mode: up to 500 items, all levels shown' })
    .option('home', { type: 'string', describe: 'The Ontologizer home to write into (default ~/.ontologizer)' }),
  handler: async (/** @type {any} */ argv) => {
    /** @type {import('../deps.js').Deps} */
    const deps = argv.deps;
    /** @type {any} */
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(argv.items === '-' || argv.items === '' ? 0 : String(argv.items), 'utf8'));
    } catch (err) {
      throw new CliError(`cannot read ${argv.items}: ${/** @type {Error} */ (err).message}`);
    }
    const checked = checkInput({ name: argv.name, items: Array.isArray(raw) ? raw : raw?.items, depth: argv.depth, mode: argv.human ? 'human' : 'agent' });
    if (!checked.ok) throw new CliError(checked.error);
    const input = checked.input;

    const store = argv.home ? openStore(argv.home) : deps.store();
    const server = runningServer(store);
    if (server) throw new CliError(`A server is running on this home (pid ${server.pid}${server.url ? `, ${server.url}` : ''}): organise through it (organize_map), or stop it first.`);

    const id = store.createDraft({ subject: input.name, context: `Organised from ${input.items.length} supplied items`, scope: '', purpose: '', level: 'expert' });
    const engine = await engineFor({ deps, store, id, needKey: deps.env.ONTOLOGIZER_ENGINE !== 'stub' });
    // Families are written only once placement is done, so the first category.added ends pass 2.
    deps.stdout.write(`Pass 1 and 2: grouping ${input.items.length} items into families, then placing each one...\n`);
    let wrote = false;
    const off = store.subscribe(id, (/** @type {any} */ e) => {
      if (e.t === 'category.added' && !wrote) { wrote = true; deps.stdout.write('Placed: writing the map...\n'); }
    });
    let r;
    try {
      r = await engine.organize(input, {});
    } catch (err) {
      throw new CliError(`${/** @type {Error} */ (err).message} (draft kept: ${id})`);
    } finally {
      off();
      store.flush(id);
    }
    const tail = r.unsorted > 0 ? ` (${r.unsorted} under Unsorted)` : '';
    deps.stdout.write(`Organised ${r.items} items into ${r.families} families: ${id}${tail}\n`);
  },
};
