// @ts-check
import { CliError } from '../deps.js';
import { engineFor, rethrowAuth, serveSession } from '../serve.js';
import { resolveName, waitForExit } from '../resolve-name.js';

export default {
  command: 'rosetta <map>',
  describe: 'Add a lens that re-explains the map for a persona',
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string', describe: 'Map name' })
    .option('as', { type: 'string', demandOption: true, describe: 'The persona, e.g. "a home chef"' })
    .option('name', { type: 'string', describe: 'Name for the lens' })
    .option('open', { type: 'boolean', default: true, hidden: true })
    .option('exit-after', { type: 'number', hidden: true }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = deps.store();
    const id = await resolveName(deps, store, String(argv.map));
    const engine = await engineFor({ deps, store, id, needKey: true });
    const srv = await serveSession({ deps, store, engine, id, open: argv.open });
    try {
      let lensId;
      try {
        lensId = await engine.rosetta(id, argv.as, { name: argv.name });
      } catch (err) {
        try { rethrowAuth(err); } catch (e) { if (e instanceof CliError) throw e; }
        throw new CliError(/** @type {Error} */ (err).message, 1);
      }
      deps.stdout.write(`Lens "${lensId}" added. Pick it under "See as" in the page.\n`);
      await waitForExit(deps, argv.exitAfter);
    } finally {
      await srv.close();
      store.flush(id);
    }
  },
};
