// @ts-check
// The optional ontologizer.config.js: find, load and validate. Loading runs the operator's own code.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_NAME = 'ontologizer.config.js';
export class ConfigError extends Error {}

const KEYS = ['identity', 'policy', 'store', 'model', 'sources'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SOURCE_KEYS = ['name', 'url', 'command', 'args', 'visibility', 'allowTools', 'headers'];

/**
 * The config file to load, or null. Never the current folder.
 * @param {{ flag?: string, env?: Record<string, string|undefined>, home: string }} o
 * @returns {string|null}
 */
export function findConfig({ flag, env, home }) {
  const explicit = flag || env?.ONTOLOGIZER_CONFIG;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!fs.existsSync(abs)) throw new ConfigError(`Config ${abs}: not found`);
    return abs;
  }
  const inHome = path.resolve(home, CONFIG_NAME);
  return fs.existsSync(inHome) ? inHome : null;
}

/** @param {any} v */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {any} obj @returns {string[]} */
export function validateConfig(obj) {
  /** @type {string[]} */
  const p = [];
  if (!isObj(obj)) return ['the default export must be an object'];
  for (const k of Object.keys(obj)) if (!KEYS.includes(k)) p.push(`unknown key "${k}"`);
  if (obj.identity !== undefined) {
    if (!isObj(obj.identity) || typeof obj.identity.authenticate !== 'function') p.push('identity must be an object with an authenticate function');
    else if (obj.identity.name !== undefined && typeof obj.identity.name !== 'string') p.push('identity.name must be a string');
  }
  if (obj.policy !== undefined) {
    if (!isObj(obj.policy) || typeof obj.policy.can !== 'function') p.push('policy must be an object with a can function');
    else if (obj.policy.name !== undefined && typeof obj.policy.name !== 'string') p.push('policy.name must be a string');
  }
  if (obj.store !== undefined && typeof obj.store !== 'function') p.push('store must be a function');
  if (obj.model !== undefined && typeof obj.model !== 'function') p.push('model must be a function');
  if (obj.sources !== undefined) {
    if (!Array.isArray(obj.sources)) p.push('sources must be an array');
    else {
      const seen = new Set();
      obj.sources.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        const at = isObj(s) && typeof s.name === 'string' && s.name ? `source "${s.name}"` : `sources[${i}]`;
        if (!isObj(s)) { p.push(`${at} must be an object`); return; }
        for (const k of Object.keys(s)) if (!SOURCE_KEYS.includes(k)) p.push(`${at}: unknown key "${k}"`);
        if (typeof s.name !== 'string' || !NAME_RE.test(s.name)) p.push(`${at}: name must match ${NAME_RE}`);
        else if (seen.has(s.name)) p.push(`${at}: duplicate name`);
        else seen.add(s.name);
        const hasUrl = s.url !== undefined; const hasCmd = s.command !== undefined;
        if (hasUrl === hasCmd) p.push(`${at}: needs exactly one of url or command`);
        if (hasUrl) {
          let ok = false;
          try { ok = typeof s.url === 'string' && ['http:', 'https:'].includes(new URL(s.url).protocol); } catch { /* bad url */ }
          if (!ok) p.push(`${at}: url must be an http or https URL`);
        }
        if (hasCmd && (typeof s.command !== 'string' || !s.command.trim())) p.push(`${at}: command must be a non-empty string`);
        if (s.args !== undefined) {
          if (!hasCmd) p.push(`${at}: args only apply to command`);
          if (!Array.isArray(s.args) || s.args.some((/** @type {any} */ a) => typeof a !== 'string')) p.push(`${at}: args must be an array of strings`);
        }
        if (s.visibility !== 'public' && s.visibility !== 'private') p.push(`${at}: visibility must be "public" or "private"`);
        if (!Array.isArray(s.allowTools) || !s.allowTools.length || s.allowTools.some((/** @type {any} */ t) => typeof t !== 'string' || !t)) {
          p.push(`${at}: allowTools must be a non-empty array of tool names`);
        }
        if (s.headers !== undefined && typeof s.headers !== 'function') p.push(`${at}: headers must be a function`);
        else if (s.headers !== undefined && hasCmd) p.push(`${at}: headers only apply to url (a command source sends no headers)`);
      });
    }
  }
  return p;
}

/**
 * Why a config file is unsafe to run, or null. It runs code, so it must be the current user's own
 * (or root's), not writable by group or others, in a folder others cannot write to (a world-writable
 * folder is fine only with the sticky bit, like /tmp). Symlinks are followed. Skipped on Windows.
 * @param {string} file @param {{ uid?: number, platform?: string }} [o]
 * @returns {string|null}
 */
export function configFileProblem(file, { uid = process.getuid?.(), platform = process.platform } = {}) {
  if (platform === 'win32' || typeof uid !== 'number') return null;
  let real;
  try { real = fs.realpathSync(file); } catch { return null; } // a missing file fails at import, with its own message
  const st = fs.statSync(real);
  if (st.uid !== uid && st.uid !== 0) return `${real} is owned by another user (uid ${st.uid}); it runs code, so it must be yours: chown it to yourself`;
  if (st.mode & 0o022) return `${real} can be changed by other users (mode ${(st.mode & 0o777).toString(8)}); it runs code: chmod go-w ${real}`;
  const dir = path.dirname(real);
  const ds = fs.statSync(dir);
  if ((ds.mode & 0o002) && !(ds.mode & 0o1000)) return `its folder ${dir} can be written by anyone, so the file could be swapped; move the config to a folder only you can write to (or chmod o-w ${dir})`;
  return null;
}

/**
 * Import the file (it runs the operator's code), take its default export, validate it.
 * It is refused first when other users could have changed it (see configFileProblem).
 * @param {string} file @returns {Promise<any>}
 */
export async function loadConfig(file) {
  const abs = path.resolve(file);
  const unsafe = configFileProblem(abs);
  if (unsafe) throw new ConfigError(`Config ${abs}: refused: ${unsafe}`);
  let mod;
  try {
    const st = fs.statSync(abs);
    mod = await import(`${pathToFileURL(abs).href}?v=${st.mtimeMs}-${st.size}-${Date.now()}`);
  } catch (/** @type {any} */ err) {
    throw new ConfigError(`Config ${abs}: could not load: ${err?.message ?? err}`);
  }
  const problems = validateConfig(mod.default);
  if (problems.length) throw new ConfigError(problems.map((x) => `Config ${abs}: ${x}`).join('\n'));
  return mod.default;
}

/**
 * A function's own name, or 'custom'. An arrow written as `store: (t) => ...` is named after its key by
 * the language, which says nothing: that counts as 'custom' too.
 * @param {any} fn @param {string} key
 */
const fnName = (fn, key) => (typeof fn.name === 'string' && fn.name && fn.name !== key ? fn.name : 'custom');

/** @param {any} config @returns {{ identity: string, policy: string, store: string, model: string }} */
export function portNames(config) {
  const c = config ?? {};
  return {
    identity: c.identity ? (c.identity.name || 'custom') : 'tokens',
    policy: c.policy ? (c.policy.name || 'custom') : 'default',
    store: c.store ? fnName(c.store, 'store') : 'files',
    model: c.model ? fnName(c.model, 'model') : 'default',
  };
}
