// @ts-check
// Everything a command touches in the outside world, in one injectable object, so tests can run
// every command in-process with fakes (no TTY, no browser, no keychain, no network).
import { spawn } from 'node:child_process';
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
 * The environment for any child process (browser opener, npm): never carries ANTHROPIC_API_KEY,
 * so a key the user set in their shell is not inherited by other programs.
 * @param {NodeJS.ProcessEnv} env
 */
export function childEnv(env) {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  return out;
}

/** Open a URL in the default browser, with a key-free env. @param {string} url @param {NodeJS.ProcessEnv} env */
function openUrl(url, env) {
  // Only ever our own local server; never a shell (no cmd.exe on Windows).
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url)) return Promise.resolve(undefined);
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { env: childEnv(env), stdio: 'ignore', detached: true });
      child.on('error', () => resolve(undefined));
      child.unref();
      resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
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
      await openUrl(url, env);
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
