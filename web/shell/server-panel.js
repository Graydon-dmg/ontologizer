// @ts-check
// Formatting for the Server panel (no DOM). Only a token's name and scopes can reach the output.

/** @param {any} t @returns {string} "name — scope, scope" */
export function tokenLine(t) {
  const name = typeof t?.name === 'string' ? t.name : '';
  const scopes = Array.isArray(t?.scopes) ? t.scopes.filter((/** @type {any} */ s) => typeof s === 'string') : [];
  const base = `${name} — ${scopes.join(', ')}`;
  const srcs = Array.isArray(t?.sources) ? t.sources.filter((/** @type {any} */ s) => typeof s === 'string') : [];
  return srcs.length ? `${base} · sources: ${srcs.join(', ')}` : base;
}

/** The configured sources, one line each; null when the status has none (an I1 server).
 * @param {any} status @returns {string[]|null} */
export function sourceLines(status) {
  if (!Array.isArray(status?.sources)) return null;
  return status.sources.filter((/** @type {any} */ s) => s && typeof s.name === 'string')
    .map((/** @type {any} */ s) => `${s.name} — ${s.visibility === 'private' ? 'private' : 'public'}, ${s.reachable ? 'reachable' : 'unreachable'}`);
}

/** "identity: tokens · policy: default · store: files · model: default", or null without ports.
 * @param {any} status @returns {string|null} */
export function portsLine(status) {
  const p = status?.ports;
  if (!p || typeof p !== 'object') return null;
  return ['identity', 'policy', 'store', 'model'].filter((k) => typeof p[k] === 'string').map((k) => `${k}: ${p[k]}`).join(' · ') || null;
}

/** @param {any} tokens @returns {string[]} */
export function tokenLines(tokens) {
  return Array.isArray(tokens) ? tokens.map(tokenLine) : [];
}

export const NO_TOKENS = 'No tokens: this server is open on loopback only.';
export const HELP = 'Manage tokens with `ontologizer token create / list / revoke`.';

/** @param {any} auth @returns {string} */
const authText = (auth) => (auth === 'open' ? 'open (no tokens, loopback only)' : auth === 'tokens' ? 'tokens' : 'unknown');

/** The optional note from the status, or ''. @param {any} status @returns {string} */
export const noteText = (status) => (typeof status?.note === 'string' ? status.note : '');

/** @param {any} status @returns {{ label: string, value: string }[]} */
export function panelRows(status) {
  const s = status ?? {};
  return [
    { label: 'Tenant', value: String(s.tenant ?? '') },
    { label: 'Store', value: String(s.store ?? '') },
    { label: 'Auth', value: authText(s.auth) },
    { label: 'Maps', value: String(s.maps ?? 0) },
    { label: 'Version', value: String(s.server?.version ?? '') },
  ];
}

/** A short message for a failed status request. @param {number} status @param {string} [error] */
export function failureText(status, error) {
  if (status === 401) return 'Sign in to see the server status.';
  if (status === 403) return 'This token cannot read the server status (it needs the read scope).';
  return error || 'The server status is not available.';
}

const n = (/** @type {any} */ v) => Number(v).toLocaleString('en-US');

/** The Usage section's lines from GET .../usage; [] when it is not a usage object.
 * @param {any} u @returns {string[]} */
export function usageLines(u) {
  if (!u || typeof u !== 'object' || !Number.isFinite(u.calls)) return [];
  const tokens = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0);
  const out = [`Today (UTC): ${n(u.calls)} model calls, ${n(tokens)} tokens`];
  const lim = [];
  if (Number.isFinite(u.limits?.calls)) lim.push(`${n(u.limits.calls)} calls`);
  if (Number.isFinite(u.limits?.tokens)) lim.push(`${n(u.limits.tokens)} tokens`);
  if (lim.length) out.push(`Limits: ${lim.join(', ')} a day`);
  return out;
}

export const NO_USAGE = 'Usage not available';
