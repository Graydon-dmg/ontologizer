// @ts-check
import { runNodeJob } from '../resolve-name.js';

export default {
  command: 'explain <name> <node>',
  describe: 'Write an article for one node',
  builder: (/** @type {any} */ y) => y
    .positional('name', { type: 'string' })
    .positional('node', { type: 'string', describe: 'Node id or label' }),
  handler: (/** @type {any} */ argv) => runNodeJob(argv, 'explain'),
};
