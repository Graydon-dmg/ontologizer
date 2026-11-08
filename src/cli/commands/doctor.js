// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keySource } from '../apikey.js';
import { latestVersion } from '../notice.js';

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

    const major = Number(process.versions.node.split('.')[0]);
    rows.push(major >= 20
      ? { s: 'ok', label: 'Node', msg: process.versions.node }
      : { s: 'fail', label: 'Node', msg: `${process.versions.node} (need 20 or newer)`, fix: 'install Node 20+' });

    const src = keySource({ keyring: deps.keyring, env });
    rows.push(src === 'env' || src === 'keychain'
      ? { s: 'ok', label: 'API key', msg: `found (${src})` }
      : { s: 'fail', label: 'API key', msg: 'not set', fix: 'ontologizer key set' });

    try {
      await deps.fetch('https://api.anthropic.com', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      rows.push({ s: 'ok', label: 'Network', msg: 'api.anthropic.com reachable' });
    } catch {
      rows.push({ s: 'warn', label: 'Network', msg: 'cannot reach api.anthropic.com (load demo --replay still works)', fix: 'check the connection' });
    }

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
    const latest = await latestVersion(deps);
    if (latest == null) rows.push({ s: 'warn', label: 'Version', msg: `${current} (could not check for updates)` });
    else if (cmp(latest, current) > 0) rows.push({ s: 'warn', label: 'Version', msg: `${current}, ${latest} is available`, fix: 'ontologizer update' });
    else rows.push({ s: 'ok', label: 'Version', msg: current });

    for (const r of rows) {
      deps.stdout.write(`${r.s.padEnd(4)} ${r.label} ${r.msg}\n`);
      if (r.s !== 'ok' && r.fix) deps.stdout.write(`     fix: ${r.fix}\n`);
    }
    if (rows.some((r) => r.s === 'fail')) deps.exitCode = 1;
  },
};
