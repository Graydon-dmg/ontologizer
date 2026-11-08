// @ts-check
// Once-a-day "new version available" notice. Never blocks and never throws.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_LATEST = 'https://registry.npmjs.org/ontologizer/latest';
const DAY = 24 * 3600 * 1000;

/** @param {{env: NodeJS.ProcessEnv, home?: string}} deps */
function cachePath(deps) {
  const home = deps.home ?? deps.env.ONTOLOGIZER_HOME ?? path.join(os.homedir(), '.ontologizer');
  return path.join(home, 'update-check.json');
}

/** @param {string} a @param {string} b @returns {number} */
function cmp(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** @param {{ deps: import('./deps.js').Deps, current: string }} p */
export function checkForUpdate({ deps, current }) {
  try {
    if (deps.env.ONTOLOGIZER_NO_UPDATE_CHECK === '1' || !deps.interactive) return;
    const file = cachePath(deps);
    /** @type {any} */
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    if (typeof cache.latest === 'string' && cmp(cache.latest, current) > 0) {
      deps.stderr.write(`ontologizer ${cache.latest} is available: run ontologizer update\n`);
    }
    const checkedAt = Number(cache.checkedAt);
    if (!(Date.now() - checkedAt < DAY)) {
      Promise.resolve()
        .then(() => deps.fetch(URL_LATEST, { signal: AbortSignal.timeout(1500) }))
        .then((r) => r.json())
        .then((j) => {
          if (typeof j?.version !== 'string') return;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest: j.version }));
        })
        .catch(() => {});
    }
  } catch { /* never block startup */ }
}

/** @param {import('./deps.js').Deps} deps @returns {Promise<string|null>} */
export async function latestVersion(deps) {
  try {
    const r = await deps.fetch(URL_LATEST, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return typeof j?.version === 'string' ? j.version : null;
  } catch {
    return null;
  }
}
