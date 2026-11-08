// @ts-check
// Everything a command touches in the outside world, in one injectable object, so tests can run
// every command in-process with fakes (no TTY, no browser, no keychain, no network).
import { defaultKeyring } from './apikey.js';
import { openStore } from '../core/store.js';

/** A user-facing failure: main prints the message to stderr and returns the code. */
export class CliError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/**
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   stdout: { write(s: string): any },
 *   stderr: { write(s: string): any },
 *   interactive: boolean,
 *   keyring: import('./apikey.js').Keyring,
 *   ask: ((opts: { message: string, mask: string }) => Promise<string>) | null,
 *   prompts: () => Promise<{ input: Function, select: Function, confirm: Function, search: Function, password: Function }>,
 *   openBrowser: (url: string) => Promise<void>,
 *   fetch: typeof fetch,
 *   onSignal: (sig: 'SIGINT', fn: () => void) => () => void,
 *   home: string | undefined,
 *   store: () => ReturnType<typeof openStore>,
 * }} Deps
 */

/**
 * @param {Partial<Deps>} [over]
 * @returns {Deps}
 */
export function makeDeps(over = {}) {
  const env = over.env ?? process.env;
  const home = over.home ?? env.ONTOLOGIZER_HOME;
  /** @type {ReturnType<typeof openStore> | null} */
  let store = null;
  return {
    env,
    stdout: process.stdout,
    stderr: process.stderr,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    keyring: over.keyring ?? defaultKeyring(env),
    ask: null,
    prompts: async () => /** @type {any} */ (await import('@inquirer/prompts')),
    openBrowser: async (url) => {
      if (env.ONTOLOGIZER_NO_OPEN === '1') return;
      const { default: open } = await import('open');
      await open(url).catch(() => {});
    },
    fetch: globalThis.fetch,
    onSignal: (sig, fn) => {
      process.on(sig, fn);
      return () => process.off(sig, fn);
    },
    home,
    store: () => (store ??= openStore(home)),
    ...over,
  };
}
