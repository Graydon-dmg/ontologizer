// @ts-check
// `ontologizer delete <map>`: move a map to the trash (<home>/.trash), where `ontologizer restore`
// can bring it back for 30 days. Asks first in a terminal; without one it needs --yes. Refuses while a
// one-map session serves the map, or a service-mode server runs on the home (both in sessions.json).
import { CliError } from '../deps.js';
import { TRASH_DAYS } from '../../core/store.js';
import { runningServer, serverRefusal } from '../served.js';

/** The actor stamped on a delete or restore made at this computer's command line. */
export const LOCAL_ACTOR = { id: 'local', kind: 'human' };

export default {
  command: 'delete <map>',
  describe: `Move a map to the trash (restore it within ${TRASH_DAYS} days)`,
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string', describe: 'The map\'s id, or a saved map\'s name, exactly (see ontologizer list --drafts)' })
    .option('yes', { type: 'boolean', default: false, describe: 'Delete without asking' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = deps.store();
    const want = String(argv.map);
    /** @type {any[]} */
    const rows = store.list({ drafts: true });
    // Exactly the id (or a saved map's name): a prefix never deletes anything.
    const row = rows.find((r) => r.id === want) ?? rows.find((r) => !r.draft && r.name === want);
    if (!row) {
      const close = rows.filter((r) => r.id.startsWith(want) || String(r.name).toLowerCase().includes(want.toLowerCase())).slice(0, 10);
      throw new CliError(`No map "${want}".${close.length ? ` Did you mean:\n${close.map((r) => `  ${r.id}${r.draft ? '  (draft)' : ''}`).join('\n')}` : ' See ontologizer list --drafts.'}`);
    }
    const label = row.name && row.name !== row.id ? `${row.id} (${row.name})` : row.id;
    // A running `serve` on this home holds its own view of the maps: open pages there would never be
    // told, and its engine would write into a map that is gone. Deleting goes through it instead.
    const server = runningServer(store);
    if (server) throw new CliError(serverRefusal(server, 'delete'));
    const live = store.sessions.get(row.id);
    if (live && live.pid !== process.pid) {
      throw new CliError(`"${row.id}" is open in a running session (port ${live.port}): stop it (Ctrl-C there), then delete it.`);
    }
    if (!argv.yes) {
      if (!deps.interactive) throw new CliError(`Refusing to delete "${row.id}" without a terminal to confirm: run it again with --yes.`);
      const { confirm } = await deps.prompts();
      const ok = await confirm({ message: `Delete ${label}? It goes to the trash and can be restored for ${TRASH_DAYS} days.`, default: false });
      if (!ok) { deps.stdout.write('Not deleted.\n'); return; }
    }
    let trashId;
    try { trashId = store.trash(row.id, { actor: LOCAL_ACTOR }); } catch (err) { throw new CliError(/** @type {Error} */ (err).message); }
    deps.stdout.write(`Moved ${label} to the trash.\nRestore it within ${TRASH_DAYS} days: ontologizer restore ${trashId}\n`);
  },
};
