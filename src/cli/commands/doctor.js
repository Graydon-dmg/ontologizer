// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keySource, probeKeychain } from '../apikey.js';
import { latestVersion } from '../notice.js';

/**
 * A hard upper bound on an async check (a ref'd timer, so it always fires).
 * @template T @param {Promise<T>} p @param {number} ms @returns {Promise<T|'timeout'>}
 */
function withTimeout(p, ms) {
  /** @type {any} */
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r('timeout'), ms); })])
    .finally(() => clearTimeout(t));
}

export const MIN_NODE = 22;

/** The Node row: ok on 22 or newer. @param {string} version e.g. "22.3.0" */
export function nodeRow(version) {
  const major = Number(String(version).split('.')[0]);
  return major >= MIN_NODE
    ? { s: /** @type {const} */ ('ok'), label: 'Node', msg: version }
    : { s: /** @type {const} */ ('fail'), label: 'Node', msg: `${version} (need ${MIN_NODE} or newer)`, fix: `install Node ${MIN_NODE}+` };
}

/** @param {string} a @param {string} b */
function cmp(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export default {
  command: 'doctor',
  describe: 'Check that everything ontologizer needs is in place',
  builder: (/** @type {any} */ y) => y,
  handler: async (/** @type {any} */ argv) => {
    const deps = argv.deps;
    const env = deps.env;
    /** @type {{ s: 'ok'|'warn'|'fail', label: string, msg: string, fix?: string }[]} */
    const rows = [];
    // Each row prints the moment its check finishes, so a slow check shows where it is.
    const push = (/** @type {any} */ r) => {
      Array.prototype.push.call(rows, r);
      deps.stdout.write(`${r.s.padEnd(4)} ${r.label} ${r.msg}\n`);
      if (r.s !== 'ok' && r.fix) deps.stdout.write(`     fix: ${r.fix}\n`);
    };
    rows.push = /** @type {any} */ (push);

    // The two network checks run in parallel from the start; each has a hard limit.
    const netP = withTimeout(
      deps.fetch('https://api.anthropic.com', { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then(() => 'ok', () => 'err'),
      3500,
    );
    const versionP = withTimeout(latestVersion(deps), 3500);

    rows.push(nodeRow(process.versions.node));

    // The OS keychain is read in a child process with a 3 s limit (a native read can block on an
    // access dialog and cannot be timed out in-process). Injected keyrings (tests) are read directly.
    let src = keySource({ keyring: { get: () => null, set() {}, delete: () => false }, env });
    if (src === 'none') {
      if (/** @type {any} */ (deps.keyring).isOsKeychain) {
        const probe = probeKeychain({ env, timeoutMs: 3000 });
        src = probe === 'present' ? 'keychain' : probe === 'timeout' ? 'timeout' : 'none';
      } else {
        src = keySource({ keyring: deps.keyring, env });
      }
    }
    rows.push(src === 'env' || src === 'keychain'
      ? { s: 'ok', label: 'API key', msg: `found (${src})` }
      : src === 'timeout'
        ? { s: 'warn', label: 'API key', msg: 'the keychain did not answer within 3 s (an access dialog may be open)', fix: 'allow access in the dialog, or run ontologizer key' }
        : { s: 'fail', label: 'API key', msg: 'not set', fix: 'ontologizer key set' });

    const net = await netP;
    rows.push(net === 'ok'
      ? { s: 'ok', label: 'Network', msg: 'api.anthropic.com reachable' }
      : { s: 'warn', label: 'Network', msg: 'cannot reach api.anthropic.com (load demo --replay still works)', fix: 'check the connection' });

    const home = deps.home ?? env.ONTOLOGIZER_HOME ?? path.join(os.homedir(), '.ontologizer');
    try {
      fs.mkdirSync(home, { recursive: true });
      const t = path.join(home, `.doctor-${process.pid}.tmp`);
      fs.writeFileSync(t, 'x');
      fs.rmSync(t);
      rows.push({ s: 'ok', label: 'Store', msg: `${home} is writable` });
    } catch {
      rows.push({ s: 'fail', label: 'Store', msg: `${home} is not writable`, fix: 'fix the permissions on the folder' });
    }

    const shell = String(env.SHELL ?? '').split('/').pop();
    const sh = shell === 'zsh' || shell === 'fish' ? shell : 'bash';
    const rcRel = sh === 'zsh' ? '.zshrc' : sh === 'fish' ? '.config/fish/config.fish' : '.bashrc';
    const line = sh === 'fish' ? 'ontologizer completion fish | source' : `eval "$(ontologizer completion ${sh})"`;
    let hasCompletion = false;
    try {
      hasCompletion = fs.readFileSync(path.join(env.HOME ?? os.homedir(), rcRel), 'utf8').includes('ontologizer completion');
    } catch { /* no rc file */ }
    rows.push(hasCompletion
      ? { s: 'ok', label: 'Completion', msg: `installed in ~/${rcRel}` }
      : { s: 'warn', label: 'Completion', msg: 'not installed', fix: `add to ~/${rcRel}: ${line}` });

    const current = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
    const v = await versionP;
    const latest = v === 'timeout' ? null : v;
    if (latest == null) rows.push({ s: 'warn', label: 'Version', msg: `${current} (could not check for updates)` });
    else if (cmp(latest, current) > 0) rows.push({ s: 'warn', label: 'Version', msg: `${current}, ${latest} is available`, fix: 'ontologizer update' });
    else rows.push({ s: 'ok', label: 'Version', msg: current });

    if (rows.some((r) => r.s === 'fail')) deps.exitCode = 1;
  },
};
