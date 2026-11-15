// @ts-check
// ontologizer hydrate: placeholder until the agent-maps train lands its handler.
import { CliError } from '../deps.js';

export default {
  command: 'hydrate <map>',
  describe: 'Write agent-facing fields (job, examples, look-alikes) on nodes',
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string' })
    .option('all', { type: 'boolean', describe: 'Hydrate every node except the root' })
    .option('nodes', { type: 'string', describe: 'Comma-separated node ids to hydrate' })
    .option('model', { type: 'string', choices: ['sonnet', 'haiku'], default: 'sonnet', describe: 'Which model writes the fields' })
    .option('redo', { type: 'boolean', default: false, describe: 'Hydrate nodes that already have fields' })
    .option('home', { type: 'string', describe: 'Store home directory' }),
  handler: async () => { throw new CliError('hydrate is not built yet', 1); },
};
