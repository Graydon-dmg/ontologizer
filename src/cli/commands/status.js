// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, TENANT_RE } from '../../core/store.js';
import { readTokens, tokensPath, publicRows } from '../../server/tokens.js';
import { CliError } from '../deps.js';
import { TOKENS_FOUND_NOTE } from '../../server/service.js';

/** @param {any} argv @param {any} deps @returns {string} */
export function resolveHome(argv, deps) {
  return argv.home ?? deps.home ?? deps.env?.ONTOLOGIZER_HOME ?? path.join(os.homedir(), '.ontologizer');
}

/** @param {number} pid */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (/** @type {any} */ err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/** @param {string} home */
function readServer(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'serve.json'), 'utf8'));
    if (j && alive(j.pid)) return { url: String(j.url), pid: j.pid, startedAt: j.startedAt ?? null, auth: j.auth === 'open' || j.auth === 'tokens' ? j.auth : null };
  } catch { /* no server file */ }
  return null;
}

/** @param {string} home */
function tenantNames(home) {
  const names = ['default'];
  try {
    for (const e of fs.readdirSync(path.join(home, 'tenants'), { withFileTypes: true })) {
      if (e.isDirectory() && TENANT_RE.test(e.name) && e.name !== 'default') names.push(e.name);
    }
  } catch { /* no tenants dir */ }
  return [...names.slice(0, 1), ...names.slice(1).sort()];
}

/** @param {string} home @param {string} tenant */
function countMaps(home, tenant) {
  // Do not create a home or tenant dir just to count zero.
  const dir = tenant === 'default' ? home : path.join(home, 'tenants', tenant);
  if (!fs.existsSync(dir)) return 0;
  return openStore(home, { tenant }).list({ drafts: true }).length;
}

export default {
  command: 'status',
  describe: 'Show the home, tenants, tokens and running server',
  builder: (/** @type {any} */ y) => y
    .option('home', { type: 'string', describe: 'Store home directory' })
    .option('json', { type: 'boolean', default: false, describe: 'Print one JSON object' }),
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const home = resolveHome(argv, deps);
    const tenants = tenantNames(home).map((tenant) => ({ tenant, maps: countMaps(home, tenant) }));
    let tokens;
    try {
      tokens = publicRows(readTokens(tokensPath(home)));
    } catch (/** @type {any} */ err) {
      throw new CliError(err.message, 1);
    }
    const server = readServer(home);
    // A server that started open stays open until restarted, even after tokens are created.
    const note = server?.auth === 'open' && tokens.length ? TOKENS_FOUND_NOTE : null;
    if (argv.json) {
      deps.stdout.write(`${JSON.stringify({ home, tenants, tokens, server, ...(note ? { note } : {}) })}\n`);
      return;
    }
    const out = [`Home: ${home}`, 'Tenants:'];
    for (const t of tenants) out.push(`  ${t.tenant}  ${t.maps} ${t.maps === 1 ? 'map' : 'maps'}`);
    if (!tokens.length) out.push('No tokens: service mode listens on loopback only.');
    else {
      out.push('Tokens:');
      for (const t of tokens) out.push(`  ${t.name}  tenant ${t.tenant}  scopes ${t.scopes.join(',')}`);
    }
    out.push(server ? `Server: running at ${server.url} (pid ${server.pid})${server.auth ? `, auth: ${server.auth}` : ''}` : 'Server: not running');
    if (note) out.push(`Note: ${note}`);
    deps.stdout.write(`${out.join('\n')}\n`);
  },
};
