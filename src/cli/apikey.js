// @ts-check
// Where the Anthropic API key comes from: env, else the OS keychain, else a masked prompt that
// stores it in the keychain. The key is never printed, logged, written to a file, or put into
// process.env (child processes such as `open` and `npm i -g` would inherit it).
//
// Keychain entry: service "ontologizer", account "anthropic-api-key", via @napi-rs/keyring (Entry).
// On macOS that is a generic password, readable by hand with:
//   security find-generic-password -s ontologizer -a anthropic-api-key -w
import { createRequire } from 'node:module';

export const SERVICE = 'ontologizer';
export const ACCOUNT = 'anthropic-api-key';
export const NO_KEY_MSG =
  'No Anthropic API key. Run `ontologizer key set` in a terminal, or set ANTHROPIC_API_KEY.';
export const NO_KEY_JOB_MSG = 'No Anthropic API key: run ontologizer key set';
export const REJECTED_MSG = 'Your Anthropic API key was rejected: run ontologizer key set';
const KEY_PREFIX = 'sk-ant-';
const MAX_TRIES = 3;

/** @typedef {{ get(): string|null, set(key: string): void, delete(): boolean }} Keyring */

/** An always-empty keyring whose set() is a no-op. For tests only (ONTOLOGIZER_KEYRING=none). */
function noneKeyring() {
  return { get: () => null, set: () => {}, delete: () => false };
}

/**
 * The OS keychain, or the empty test keyring when ONTOLOGIZER_KEYRING=none.
 * The native module loads lazily, so commands that never need a key never load it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Keyring}
 */
export function defaultKeyring(env = process.env) {
  if (env.ONTOLOGIZER_KEYRING === 'none') return noneKeyring();
  /** @type {any} */
  let entry = null;
  const getEntry = () => {
    if (!entry) {
      const { Entry } = createRequire(import.meta.url)('@napi-rs/keyring');
      entry = new Entry(SERVICE, ACCOUNT);
    }
    return entry;
  };
  return {
    get() {
      try {
        const v = getEntry().getPassword();
        return typeof v === 'string' && v.length > 0 ? v : null;
      } catch {
        return null; // no entry, or no keychain on this system
      }
    },
    set(key) {
      getEntry().setPassword(key); // throws when there is no keychain (e.g. Linux without Secret Service)
    },
    delete() {
      try {
        return Boolean(getEntry().deletePassword());
      } catch {
        return false;
      }
    },
  };
}

/** @param {unknown} key */
function looksLikeKey(key) {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && key.length > KEY_PREFIX.length;
}

/** @param {{ message: string, mask: string }} opts */
async function defaultAsk(opts) {
  const { password } = await import('@inquirer/prompts');
  return password(opts);
}

/**
 * Ask for a key with a masked prompt (3 tries, must start with "sk-ant-") and store it.
 * Used by getApiKey and by `ontologizer key set`.
 * @param {{ keyring: Keyring, ask?: ((opts: { message: string, mask: string }) => Promise<string>)|null,
 *           stderr?: { write(s: string): any } }} opts
 * @returns {Promise<string>}
 */
export async function promptAndStoreKey({ keyring, ask = null, stderr = process.stderr }) {
  const askFn = ask ?? defaultAsk;
  for (let i = 0; i < MAX_TRIES; i++) {
    const raw = await askFn({ message: 'Anthropic API key:', mask: '*' });
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!looksLikeKey(key)) {
      stderr.write('That does not look like an Anthropic API key (it starts with "sk-ant-").\n');
      continue;
    }
    try {
      keyring.set(key);
      stderr.write('Saved to your system keychain.\n');
    } catch {
      stderr.write(
        'Could not save the key to the keychain: set ANTHROPIC_API_KEY to skip this prompt\n',
      );
    }
    return key;
  }
  throw new Error('No valid Anthropic API key entered.');
}

/**
 * @param {{ keyring?: Keyring, env?: NodeJS.ProcessEnv, interactive?: boolean,
 *           ask?: ((opts: { message: string, mask: string }) => Promise<string>)|null,
 *           stderr?: { write(s: string): any } }} [opts]
 * @returns {Promise<{ key: string, source: 'env'|'keychain'|'prompt' }>}
 */
export async function getApiKey({
  keyring,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY),
  ask = null,
  stderr = process.stderr,
} = {}) {
  // 1. env wins, and is checked before the keyring is touched at all.
  const fromEnv = env.ANTHROPIC_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { key: fromEnv.trim(), source: 'env' };
  }
  const kr = keyring ?? defaultKeyring(env);
  // 2. the keychain.
  const stored = kr.get();
  if (stored) return { key: stored, source: 'keychain' };
  // 4. no TTY: never wait for input.
  if (!interactive) throw new Error(NO_KEY_MSG);
  // 3. ask once, store it.
  const key = await promptAndStoreKey({ keyring: kr, ask, stderr });
  return { key, source: 'prompt' };
}

/**
 * Where the key would come from right now, without prompting: for `ontologizer key` and doctor.
 * @param {{ keyring?: Keyring, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {'env'|'keychain'|'none'}
 */
export function keySource({ keyring, env = process.env } = {}) {
  const fromEnv = env.ANTHROPIC_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return 'env';
  return (keyring ?? defaultKeyring(env)).get() ? 'keychain' : 'none';
}

/** True for the SDK's AuthenticationError (HTTP 401). @param {any} err */
export function isAuthError(err) {
  return Boolean(err) && (err.status === 401 || err.name === 'AuthenticationError');
}

/** Build the SDK client from a key. The key goes only into the client object. @param {string} apiKey */
export async function makeClient(apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

/**
 * A stand-in client for sessions with no key (load never prompts): every model call fails with
 * the contract's job message, so a clicked job ends as job.failed instead of hanging or crashing.
 */
export function noKeyClient() {
  const fail = () => {
    throw new Error(NO_KEY_JOB_MSG);
  };
  return { messages: { stream: fail, create: fail } };
}
