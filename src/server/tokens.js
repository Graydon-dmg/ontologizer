// @ts-check
// Bearer tokens for service mode. <home>/tokens.json holds only SHA-256 hashes, never a secret.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TENANT_RE } from '../core/store.js';

/** @typedef {{ name: string, tenant: string, scopes: string[], hash: string, created: string, sources?: string[] }} TokenRow */

/**
 * Scopes are a ladder: each implies the ones before it. read only reads; ask also asks the map (it
 * calls the model and writes the chat to the map); build also builds and changes maps; admin is all,
 * plus every tenant's status.
 */
export const SCOPES = ['read', 'ask', 'build', 'admin'];

/**
 * Whether `scopes` (a token's) cover `need`.
 * @param {string[]} scopes @param {string} need
 */
export function hasScope(scopes, need) {
  const want = SCOPES.indexOf(need);
  if (want < 0) return false;
  return (Array.isArray(scopes) ? scopes : []).some((s) => SCOPES.indexOf(s) >= want);
}
export const TOKEN_RE = /^ont_[A-Za-z0-9_-]{43}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** @param {string} home */
export function tokensPath(home) {
  return path.join(home, 'tokens.json');
}

export function newToken() {
  return `ont_${crypto.randomBytes(32).toString('base64url')}`;
}

/** @param {string} token */
export function hashToken(token) {
  return `sha256:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
}

/** @param {any} r */
function validRow(r) {
  return r && typeof r === 'object' && typeof r.name === 'string' && typeof r.tenant === 'string'
    && Array.isArray(r.scopes) && r.scopes.every((/** @type {any} */ s) => typeof s === 'string')
    && typeof r.hash === 'string' && typeof r.created === 'string'
    && (r.sources === undefined || (Array.isArray(r.sources) && r.sources.every((/** @type {any} */ s) => typeof s === 'string')));
}

/** @param {string} file @returns {TokenRow[]} */
export function readTokens(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON. Fix or remove it.`);
  }
  if (!Array.isArray(rows)) throw new Error(`${file} must hold a JSON array of tokens.`);
  rows.forEach((r, i) => {
    if (!validRow(r)) throw new Error(`${file}: row ${i + 1} is not { name, tenant, scopes, hash, created }.`);
  });
  return rows;
}

/** @param {string} file @param {TokenRow[]} rows */
export function writeTokens(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on every platform */ }
}

/**
 * @param {string} file
 * @param {{ name: string, tenant?: string, scopes?: string[], sources?: string[], now?: Date }} o
 * @returns {{ token: string, row: TokenRow }}
 */
export function createToken(file, { name, tenant = 'default', scopes = ['read', 'build'], sources, now = new Date() }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Invalid token name "${name}": use lowercase letters, digits, "_", "." and "-" (start with a letter or digit).`);
  }
  if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) {
    throw new Error(`Invalid tenant "${tenant}": use lowercase letters, digits and hyphens.`);
  }
  if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => SCOPES.includes(s))) {
    throw new Error(`Invalid scopes: each must be one of ${SCOPES.join(', ')}.`);
  }
  if (sources !== undefined && (!Array.isArray(sources) || !sources.length || !sources.every((s) => typeof s === 'string' && SOURCE_NAME_RE.test(s)))) {
    throw new Error('Invalid sources: a non-empty list of source names (lowercase letters, digits and hyphens).');
  }
  const rows = readTokens(file);
  if (rows.some((r) => r.name === name)) throw new Error(`A token named "${name}" already exists.`);
  const token = newToken();
  /** @type {TokenRow} */
  const row = {
    name, tenant, scopes: [...new Set(scopes)], hash: hashToken(token),
    created: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(sources ? { sources: [...new Set(sources)] } : {}),
  };
  writeTokens(file, [...rows, row]);
  return { token, row };
}

/** @param {string} file @param {string} name */
export function revokeToken(file, name) {
  const rows = readTokens(file);
  const kept = rows.filter((r) => r.name !== name);
  if (kept.length === rows.length) return false;
  writeTokens(file, kept);
  return true;
}

/** @param {TokenRow[]} rows @param {any} token @returns {TokenRow|null} */
export function checkToken(rows, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const want = Buffer.from(hashToken(token));
  /** @type {TokenRow|null} */
  let found = null;
  for (const r of rows) {
    const have = Buffer.from(String(r.hash));
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) found = r;
  }
  return found;
}

/** @param {TokenRow[]} rows */
export function publicRows(rows) {
  return rows.map((r) => ({ name: r.name, tenant: r.tenant, scopes: [...r.scopes], created: r.created, ...(r.sources ? { sources: [...r.sources] } : {}) }));
}
