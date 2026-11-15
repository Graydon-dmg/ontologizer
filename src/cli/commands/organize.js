// @ts-check
// ontologizer organize: placeholder until the agent-maps train lands its handler.
import { CliError } from '../deps.js';

export default {
  command: 'organize <items>',
  describe: 'Organise a list of items (a JSON file, or - for stdin) into a map',
  builder: (/** @type {any} */ y) => y
    .positional('items', { type: 'string', describe: 'A JSON file of items, each { id, label, text? }, or - to read stdin' })
    .option('name', { type: 'string', demandOption: true, describe: 'A display name for the map' })
    .option('depth', { type: 'number', default: 3, choices: [2, 3, 4], describe: 'Levels below the root, leaves included' })
    .option('human', { type: 'boolean', default: false, describe: 'Human mode: up to 500 items, all shown' })
    .option('home', { type: 'string', describe: 'Store home directory' }),
  handler: async () => { throw new CliError('organize is not built yet', 1); },
};
