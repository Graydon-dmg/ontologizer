// @ts-check
// `ontologizer add-node <map> --parent <nodeId> --label <label>`: add exactly one named node to a map
// in the local store, through the same addNode() the server's add_node action uses. No model is
// called. Refuses while a server, or a one-map session, serves the home: it holds its own copy of the
// map, and its open pages would never see the node.
import { CliError } from '../deps.js';
import { openStore } from '../../core/store.js';
import { resolveName } from '../resolve-name.js';
import { runningServer } from '../served.js';
import { addNode } from '../../server/actions/add-node.js';
import { LOCAL_ACTOR } from './delete.js';
import { resolveHome } from './status.js';

export default {
  command: 'add-node <map>',
  describe: 'Add one named node under a parent (no model call)',
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string', describe: 'The map\'s id or name' })
    .option('parent', { type: 'string', demandOption: true, describe: 'The id of the node to add under, e.g. "_root/finance"' })
    .option('label', { type: 'string', demandOption: true, describe: 'The new node\'s label, 1 to 80 characters' })
    .option('summary', { type: 'string', describe: 'A one-line summary, at most 300 characters' })
    .option('home', { type: 'string', describe: 'Store home directory' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const store = argv.home !== undefined ? openStore(resolveHome(argv, deps)) : deps.store();
    const server = runningServer(store);
    if (server) throw new CliError(`ontologizer: a server is running on this home (pid ${server.pid}${server.url ? `, ${server.url}` : ''}): add the node through it (add_node), or stop it first.`);
    const id = await resolveName(deps, store, String(argv.map));
    const live = store.sessions.get(id);
    if (live && live.pid !== process.pid) {
      throw new CliError(`ontologizer: "${id}" is open in a running session (port ${live.port}): stop it (Ctrl-C there), then add the node.`);
    }
    /** @param {string} t @param {object} fields */
    const emit = (t, fields) => store.append(id, { t, at: store.now(id), ...fields, actor: LOCAL_ACTOR });
    const r = addNode(store, id, { parentId: argv.parent, label: argv.label, summary: argv.summary }, { emit });
    if (r.status !== 201) throw new CliError(`ontologizer: ${r.error}`);
    deps.stdout.write(`Added ${r.node.id} under ${argv.parent}\n`);
  },
};
