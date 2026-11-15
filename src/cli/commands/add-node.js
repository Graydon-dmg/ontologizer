// @ts-check
// ontologizer add-node: placeholder until the agent-maps train lands its handler.
import { CliError } from '../deps.js';

export default {
  command: 'add-node <map>',
  describe: 'Add exactly one named node under a parent',
  builder: (/** @type {any} */ y) => y
    .positional('map', { type: 'string' })
    .option('parent', { type: 'string', demandOption: true, describe: 'The id of the node to add under' })
    .option('label', { type: 'string', demandOption: true, describe: 'The new node\'s label' })
    .option('summary', { type: 'string', describe: 'A one-line summary' })
    .option('home', { type: 'string', describe: 'Store home directory' }),
  handler: async () => { throw new CliError('add-node is not built yet', 1); },
};
