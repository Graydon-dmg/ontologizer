// @ts-check
// `ontologizer restore <trash-id> [--as <name>]`: bring a deleted map back from the trash.
import { CliError } from '../deps.js';
import { LOCAL_ACTOR } from './delete.js';
import { runningServer, serverRefusal } from '../served.js';

export default {
  command: 'restore <trash-id>',
  describe: 'Bring a deleted map back from the trash (see ontologizer trash)',
  builder: (/** @type {any} */ y) => y
    .positional('trash-id', { type: 'string', describe: 'The trash id, from ontologizer trash' })
    .option('as', { type: 'string', describe: 'Restore it under this name instead (a draft comes back saved)' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = deps.store();
    const trashId = String(argv.trashId);
    // A running server keeps its own view of the maps (a restored id it has cached as empty, say).
    const server = runningServer(store);
    if (server) throw new CliError(serverRefusal(server, 'restore'));
    try {
      const id = store.restore(trashId, { as: argv.as ?? null, actor: LOCAL_ACTOR });
      deps.stdout.write(`Restored ${id}. Open it with: ontologizer load ${id}\n`);
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e.code === 'TAKEN') throw new CliError(`${e.message.replace(/\.$/, '')}: add --as <name>.`);
      if (e.code === 'NOT_FOUND') throw new CliError(`"${trashId}" is not in the trash. See ontologizer trash.`);
      throw new CliError(String(e.message));
    }
  },
};
