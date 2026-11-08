// @ts-check
import { CliError } from '../deps.js';

export default {
  command: 'save [name]',
  describe: 'Save the current draft',
  builder: (/** @type {any} */ y) => y.positional('name', { type: 'string', describe: 'Name to save as' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = deps.store();
    const id = store.current();
    const row = id ? store.list({ drafts: true }).find((/** @type {any} */ r) => r.id === id) : null;
    if (!row || !row.draft) throw new CliError('No current draft to save.');
    const live = store.sessions.get(id);
    if (live && live.pid !== process.pid) {
      throw new CliError('That draft is open in a running session: press Ctrl-C there to save it.');
    }
    const slug = String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const name = argv.name || slug || row.root;
    try {
      const saved = store.save(id, name);
      deps.stdout.write(`Saved as ${saved}\n`);
    } catch (err) {
      throw new CliError(/** @type {Error} */ (err).message);
    }
  },
};
