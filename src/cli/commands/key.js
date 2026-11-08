// @ts-check
// `ontologizer key [set|clear]`: show where the API key comes from, store a new one, or remove it.
// The key itself is never printed, logged or held in a variable here.
import { CliError } from '../deps.js';
import { keySource, promptAndStoreKey } from '../apikey.js';

export default {
  command: 'key [action]',
  describe: 'Show, set or clear the Anthropic API key',
  /** @param {any} y */
  builder: (y) =>
    y.positional('action', {
      describe: 'set: prompt for a key and store it in the keychain; clear: remove it',
      choices: ['set', 'clear'],
      type: 'string',
    }),
  /** @param {any} argv */
  handler: async (argv) => {
    /** @type {import('../deps.js').Deps} */
    const deps = argv.deps;
    if (argv.action === 'set') {
      if (!deps.interactive) throw new CliError('ontologizer key set needs a terminal.');
      await promptAndStoreKey({ keyring: deps.keyring, ask: deps.ask, stderr: deps.stderr, validate: deps.validateKey });
      const fromEnv = deps.env.ANTHROPIC_API_KEY;
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
        deps.stdout.write('Note: ANTHROPIC_API_KEY is set and takes precedence over the keychain.\n');
      }
      return;
    }
    if (argv.action === 'clear') {
      const had = deps.keyring.delete();
      deps.stdout.write(had ? 'Removed the key from the keychain.\n' : 'No key in the keychain.\n');
      return;
    }
    const source = keySource({ keyring: deps.keyring, env: deps.env });
    if (source === 'env') deps.stdout.write('ANTHROPIC_API_KEY (environment)\n');
    else if (source === 'keychain') {
      deps.stdout.write('keychain (service ontologizer, account anthropic-api-key)\n');
    } else {
      deps.stdout.write('none: run ontologizer key set\n');
      deps.exitCode = 1;
    }
  },
};
