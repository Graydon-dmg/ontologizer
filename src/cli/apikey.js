// @ts-check
// Where the Anthropic API key comes from: env, else the OS keychain, else a masked prompt that
// stores it in the keychain. The key is never printed, logged, written to a file, or put into
// process.env (child processes such as `open` and `npm i -g` would inherit it).
//
// Keychain entry: service "ontologizer", account "anthropic-api-key", via @napi-rs/keyring (Entry).
// On macOS that is a generic password, readable by hand with:
//   security find-generic-password -s ontologizer -a anthropic-api-key -w
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const SERVICE = 'ontologizer';
export const ACCOUNT = 'anthropic-api-key';
export const NO_KEY_MSG =
  'No Anthropic API key. Run `ontologizer key set` in a terminal, or set ANTHROPIC_API_KEY.';
export const NO_KEY_JOB_MSG = 'No Anthropic API key: run ontologizer key set';
export const REJECTED_MSG = 'Your Anthropic API key was rejected: run ontologizer key set';
export const PROMPT_REJECTED_MSG = 'That key was rejected by Anthropic. Check it and try again.';
export const UNVERIFIED_MSG = 'Could not reach Anthropic to check the key; saving it anyway.';
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
    isOsKeychain: true,
    get() {
      try {
        return validKey(getEntry().getPassword());
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

/** The trimmed key, or null when it is not a plausible Anthropic key. @param {unknown} raw */
function validKey(raw) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  return looksLikeKey(key) ? key : null;
}

/** keyring.get(), never throwing, and only a plausible key. @param {Keyring} kr */
function storedKey(kr) {
  try {
    return validKey(kr.get());
  } catch {
    return null;
  }
}

export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const NOTICE = { shown: false };

/**
 * The API base URL for every client this CLI builds (the model client, the no-key client, the key
 * check). Passed explicitly, so no SDK config can redirect the key. ANTHROPIC_BASE_URL is honoured
 * only when it is https://, or http:// to localhost / 127.0.0.1; then one notice line names the host.
 * The error names the variable, never the key.
 * @param {{ env?: NodeJS.ProcessEnv, stderr?: { write(s: string): any }, state?: { shown: boolean } }} [opts]
 * @returns {string}
 */
export function resolveBaseURL({ env = process.env, stderr = process.stderr, state = NOTICE } = {}) {
  const raw = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '';
  if (!raw) return DEFAULT_BASE_URL;
  /** @param {string} m */
  const refuse = (m) => Object.assign(new Error(m), { code: 'ONTOLOGIZER_BASE_URL' });
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw refuse('ANTHROPIC_BASE_URL is not a valid URL: unset it, or set it to an https:// address.');
  }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !local) {
    throw refuse('ANTHROPIC_BASE_URL must be https:// (or http:// to localhost or 127.0.0.1): unset it or fix it.');
  }
  if (u.username || u.password) throw refuse('ANTHROPIC_BASE_URL must not contain a user name or password.');
  if (!state.shown) {
    state.shown = true;
    stderr.write(`Using Anthropic API at ${u.host} (from ANTHROPIC_BASE_URL)\n`);
  }
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/**
 * Check a key with a free call (models.list) before it is stored.
 * 'ok': accepted. 'rejected': a 401. 'unverified': anything else (no network, timeout, a 403,
 * server error): the caller saves it with a warning. The error itself is never surfaced, so no
 * message built from the request can carry the key.
 * @param {string} key
 * @param {{ env?: NodeJS.ProcessEnv, stderr?: { write(s: string): any }, timeoutMs?: number }} [opts]
 * @returns {Promise<'ok'|'rejected'|'unverified'>}
 */
export async function checkKey(key, { env = process.env, stderr = process.stderr, timeoutMs = 10_000 } = {}) {
  const baseURL = resolveBaseURL({ env, stderr }); // a refused base URL throws: never sent, never saved
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key, baseURL, maxRetries: 0, timeout: timeoutMs });
    // The signal caps the whole call (the SDK timeout covers only the response headers).
    await client.models.list({ limit: 1 }, { signal: AbortSignal.timeout(timeoutMs) });
    return 'ok';
  } catch (/** @type {any} */ err) {
    // Only a 401 means "this key is wrong". A 403 is often a proxy or firewall: save with a warning.
    return err && (err.status === 401 || err.name === 'AuthenticationError') ? 'rejected' : 'unverified';
  }
}

/** @param {{ message: string, mask: string }} opts */
async function defaultAsk(opts) {
  const { password } = await import('@inquirer/prompts');
  return password(opts);
}

/**
 * Ask for a key with a masked prompt and store it. 3 tries in all: a key that does not start with
 * "sk-ant-", or that Anthropic rejects (checked with a free call before storing), uses a try.
 * Used by getApiKey and by `ontologizer key set`.
 * @param {{ keyring: Keyring, ask?: ((opts: { message: string, mask: string }) => Promise<string>)|null,
 *           stderr?: { write(s: string): any },
 *           validate?: (key: string) => Promise<'ok'|'rejected'|'unverified'> }} opts
 * @returns {Promise<string>}
 */
export async function promptAndStoreKey({ keyring, ask = null, stderr = process.stderr, validate = checkKey }) {
  const askFn = ask ?? defaultAsk;
  for (let i = 0; i < MAX_TRIES; i++) {
    const raw = await askFn({ message: 'Anthropic API key:', mask: '*' });
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!looksLikeKey(key)) {
      stderr.write('That does not look like an Anthropic API key (it starts with "sk-ant-").\n');
      continue;
    }
    stderr.write('Checking the key with Anthropic…\n');
    let verdict;
    try {
      verdict = await validate(key);
    } catch (/** @type {any} */ err) {
      if (err?.code === 'ONTOLOGIZER_BASE_URL') throw err; // a refused ANTHROPIC_BASE_URL: stop, save nothing
      verdict = 'unverified';
    }
    if (verdict === 'rejected') {
      stderr.write(`${PROMPT_REJECTED_MSG}\n`);
      continue;
    }
    if (verdict !== 'ok') stderr.write(`${UNVERIFIED_MSG}\n`);
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
 *           stderr?: { write(s: string): any },
 *           validate?: (key: string) => Promise<'ok'|'rejected'|'unverified'> }} [opts]
 * @returns {Promise<{ key: string, source: 'env'|'keychain'|'prompt' }>}
 */
export async function getApiKey({
  keyring,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY),
  ask = null,
  stderr = process.stderr,
  validate = checkKey,
} = {}) {
  // 1. env wins, and is checked before the keyring is touched at all.
  const fromEnv = env.ANTHROPIC_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { key: fromEnv.trim(), source: 'env' };
  }
  const kr = keyring ?? defaultKeyring(env);
  // 2. the keychain (a junk value falls through to the prompt instead of causing a 401).
  const stored = storedKey(kr);
  if (stored) return { key: stored, source: 'keychain' };
  // 4. no TTY: never wait for input.
  if (!interactive) throw new Error(NO_KEY_MSG);
  // 3. ask once, store it.
  const key = await promptAndStoreKey({ keyring: kr, ask, stderr, validate });
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
  return storedKey(keyring ?? defaultKeyring(env)) ? 'keychain' : 'none';
}

/**
 * Whether the OS keychain holds a plausible key, checked in a child process with a hard timeout,
 * so a stuck keychain (e.g. a pending access dialog) can never hang `doctor`. The child prints
 * only "1" or "0": the key itself never crosses the pipe. Its env carries no ANTHROPIC_API_KEY.
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 * @returns {'present'|'absent'|'timeout'}
 */
export function probeKeychain({ env = process.env, timeoutMs = 3000 } = {}) {
  if (env.ONTOLOGIZER_KEYRING === 'none') return 'absent';
  let modPath;
  try {
    modPath = createRequire(import.meta.url).resolve('@napi-rs/keyring');
  } catch {
    return 'absent';
  }
  const script =
    'let v=null;try{const{Entry}=require(process.argv[1]);v=new Entry(process.argv[2],process.argv[3]).getPassword()}catch{}' +
    ";process.stdout.write(typeof v==='string'&&v.trim().startsWith('sk-ant-')&&v.trim().length>7?'1':'0')";
  const childEnvNoKey = { ...env };
  delete childEnvNoKey.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, ['-e', script, modPath, SERVICE, ACCOUNT], {
    env: childEnvNoKey, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.signal) return 'timeout';
  return r.stdout === '1' ? 'present' : 'absent';
}

/** True for the SDK's AuthenticationError (HTTP 401). @param {any} err */
export function isAuthError(err) {
  return Boolean(err) && (err.status === 401 || err.name === 'AuthenticationError');
}

/** Build the SDK client from a key. The key goes only into the client object. @param {string} apiKey */
export async function makeClient(apiKey, { env = process.env, stderr = process.stderr } = {}) {
  const baseURL = resolveBaseURL({ env, stderr });
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, baseURL });
}

/**
 * The client for a session that started with no key (load never prompts). On every use it re-reads
 * the keychain (never prompting): once `ontologizer key set` has stored a key in another terminal,
 * it builds the real client and delegates to it. Until then every model call fails with the
 * contract's job message, so a clicked job ends as job.failed instead of hanging or crashing.
 * @param {{ keyring: Keyring, env?: NodeJS.ProcessEnv, stderr?: { write(s: string): any } }} opts
 */
export async function noKeyClient({ keyring, env = process.env, stderr = process.stderr }) {
  const baseURL = resolveBaseURL({ env, stderr });
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  /** @type {any} */
  let real = null;
  const current = () => {
    if (!real) {
      const key = storedKey(keyring);
      if (key) real = new Anthropic({ apiKey: key, baseURL });
    }
    return real;
  };
  const fail = () => {
    throw new Error(NO_KEY_JOB_MSG);
  };
  const failing = { stream: fail, create: fail };
  return new Proxy({}, {
    get(_target, prop) {
      const c = current();
      if (c) {
        const v = c[prop];
        return typeof v === 'function' ? v.bind(c) : v;
      }
      return prop === 'messages' ? failing : undefined;
    },
  });
}
