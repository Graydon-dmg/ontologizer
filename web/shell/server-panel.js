// @ts-check
// Formatting for the Server panel (no DOM). Only a token's name and scopes can reach the output.

/** @param {any} t @returns {string} "name — scope, scope" */
export function tokenLine(t) {
  const name = typeof t?.name === 'string' ? t.name : '';
  const scopes = Array.isArray(t?.scopes) ? t.scopes.filter((/** @type {any} */ s) => typeof s === 'string') : [];
  return `${name} — ${scopes.join(', ')}`;
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
