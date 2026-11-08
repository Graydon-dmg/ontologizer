// @ts-check
// Shared by the commands: get an engine (with the key wired in), serve a session, wait for Ctrl-C.
import { getApiKey, makeClient, noKeyClient, isAuthError, REJECTED_MSG } from './apikey.js';
import { loadEngine } from './engine.js';
import { CliError } from './deps.js';
import { startServer } from '../server/index.js';

/**
 * The engine for one ontology.
 * needKey true (new, explain, research, fuse, rosetta): resolve the key first (env, keychain,
 *   then a masked prompt when interactive); no key -> CliError with the contract message.
 * needKey false (load): never prompts. Uses a key if env or the keychain has one; otherwise the
 *   engine gets a client whose calls fail with "No Anthropic API key: run ontologizer key set".
 * The key only ever goes into the SDK client object.
 * @param {{ deps: import('./deps.js').Deps, store: any, id: string, needKey: boolean }} opts
 */
export async function engineFor({ deps, store, id, needKey }) {
  let client;
  try {
    const { key } = await getApiKey({
      keyring: deps.keyring,
      env: deps.env,
      interactive: needKey ? deps.interactive : false,
      ask: deps.ask,
      stderr: deps.stderr,
    });
    client = await makeClient(key);
  } catch (err) {
    if (needKey) throw new CliError(/** @type {Error} */ (err).message, 1);
    client = noKeyClient();
  }
  return loadEngine({ store, id, client, env: deps.env });
}

/** Turn an SDK 401 into the contract message; rethrow anything else. @param {unknown} err */
export function rethrowAuth(err) {
  if (isAuthError(err)) throw new CliError(REJECTED_MSG, 1);
  throw err;
}

/**
 * Start the server for `id`, print its URL, open the browser.
 * @param {{ deps: import('./deps.js').Deps, store: any, engine: any, id: string,
 *           replay?: null | { speed: number }, open?: boolean }} opts
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function serveSession({ deps, store, engine, id, replay = null, open = true }) {
  const srv = await startServer({ store, engine, id, replay });
  const name = store.read(id).name || id;
  deps.stdout.write(`Serving ${name} at ${srv.url}  (Ctrl-C to stop)\n`);
  if (open) await deps.openBrowser(srv.url);
  return srv;
}

/**
 * Resolves on the first Ctrl-C (SIGINT). Later Ctrl-Cs during the save prompt are left to the prompt.
 * @param {import('./deps.js').Deps} deps
 * @returns {Promise<void>}
 */
export function untilInterrupt(deps) {
  return new Promise((resolve) => {
    const off = deps.onSignal('SIGINT', () => {
      off();
      resolve();
    });
  });
}
