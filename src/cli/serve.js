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
    if (/** @type {any} */ (err)?.name === 'ExitPromptError') throw err; // Ctrl-C at the prompt: exit 130 quietly
    if (needKey) throw new CliError(/** @type {Error} */ (err).message, 1);
    client = await noKeyClient({ keyring: deps.keyring });
  }
  return loadEngine({ store, id, client, env: deps.env });
}

/** Turn an SDK 401 into the contract message; rethrow anything else. @param {unknown} err */
export function rethrowAuth(err) {
  if (isAuthError(err)) throw new CliError(REJECTED_MSG, 1);
  throw err;
}

/** A --port value: 0 (any free port) or 1024..65535. @param {unknown} v */
export function checkPort(v) {
  const n = v === undefined ? 0 : Number(v);
  if (!Number.isInteger(n) || (n !== 0 && (n < 1024 || n > 65535))) {
    throw new CliError('--port must be a whole number from 1024 to 65535.', 1);
  }
  return n;
}

/**
 * Start the server for `id`, print its URL, open the browser.
 * @param {{ deps: import('./deps.js').Deps, store: any, engine: any, id: string,
 *           replay?: null | { speed: number }, open?: boolean, port?: number }} opts
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function serveSession({ deps, store, engine, id, replay = null, open = true, port = 0 }) {
  // Fused drafts started from the browser get their own server; their engine never prompts.
  const makeEngine = (/** @type {string} */ draftId) => engineFor({ deps, store, id: draftId, needKey: false });
  let srv;
  try {
    srv = await startServer({ store, engine, id, replay, makeEngine, port });
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'EADDRINUSE') throw new CliError(`Port ${port} is already in use: pick another with --port, or leave it out.`, 1);
    throw err;
  }
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
