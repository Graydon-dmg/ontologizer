// @ts-check
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Required in the published tarball. `src/cli/index.js` (Epic B) and
// `fixtures/demo.events.jsonl` (Epic H recording) are added by the lead when each one lands on main.
// No "skip if missing" logic on purpose: a skip would hide a missing file at publish time.
export const REQUIRED = ['web/shared/importmap.json', 'web/index.html'];

/** @param {string} dir @returns {string[]} relative paths `npm pack` would ship */
export function packedFiles(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out)[0].files.map((/** @type {{path: string}} */ f) => f.path);
}

// Key-shaped token: prefix plus at least one key character. A bare "sk-ant-" literal (a prefix check) is fine.
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]+/;

/** @param {string} dir @param {string[]} files @param {string[]} required @returns {string[]} problems */
export function auditPack(dir, files, required) {
  const problems = [];
  for (const r of required) if (!files.includes(r)) problems.push(`missing required file: ${r}`);
  for (const f of files) {
    const base = basename(f);
    if (base === '.env' || base.startsWith('.env.')) problems.push(`env file packed: ${f}`);
    if (f.startsWith('test/')) problems.push(`test file packed: ${f}`);
    if (KEY_SHAPE.test(readFileSync(join(dir, f), 'utf8'))) problems.push(`API key pattern (sk-ant-) found in: ${f}`);
  }
  return problems;
}

/** @param {string} text @returns {string | null} problem, or null if OK */
export function checkShebang(text) {
  return text.startsWith('#!/usr/bin/env node') ? null : 'missing "#!/usr/bin/env node" shebang';
}
