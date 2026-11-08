// @ts-check
import { complete } from '../complete.js';

export default {
  command: '__complete [words..]',
  describe: false,
  builder: (/** @type {any} */ y) => y.positional('words', { type: 'string', array: true }),
  handler: async (/** @type {any} */ argv) => {
    const words = (argv.words ?? []).map(String);
    argv.deps.stdout.write(complete(words).map((c) => `${c}\n`).join(''));
  },
};
