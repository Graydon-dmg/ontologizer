// @ts-check
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Required in the published tarball.
// No "skip if missing" logic on purpose: a skip would hide a missing file at publish time.
export const REQUIRED = ['src/cli/index.js', 'web/index.html', 'web/shared/importmap.json', 'fixtures/demo.events.jsonl'];

// Everything packed must be one of these files or live under one of these folders.
// Keeps stray folders (.playwright-mcp/, docs/, .claude/) out even if `files` grows by mistake.
export const ALLOWED_FILES = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md'];

// Folders that must ship with at least one file in them (the brand assets the page and favicon use).
export const REQUIRED_DIRS = ['web/shared/brand/'];
export const ALLOWED_DIRS = ['src/', 'web/', 'fixtures/'];

/** @param {string} dir @returns {string[]} relative paths `npm pack` would ship */
export function packedFiles(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out)[0].files.map((/** @type {{path: string}} */ f) => f.path);
}

// Key-shaped token: prefix plus at least one key character. A bare "sk-ant-" literal (a prefix check) is fine.
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]+/;

/** @param {string} dir @param {string[]} files @param {string[]} required @param {string[]} [requiredDirs] @returns {string[]} problems */
export function auditPack(dir, files, required, requiredDirs = []) {
  const problems = [];
  for (const r of required) if (!files.includes(r)) problems.push(`missing required file: ${r}`);
  for (const d of requiredDirs) if (!files.some((f) => f.startsWith(d))) problems.push(`missing required folder: ${d}`);
  for (const f of files) {
    const base = basename(f);
    if (base === '.env' || base.startsWith('.env.')) problems.push(`env file packed: ${f}`);
    if (f.startsWith('test/')) problems.push(`test file packed: ${f}`);
    if (f.startsWith('web/dev/')) problems.push(`dev harness packed: ${f}`);
    if (f.endsWith('.md') && !ALLOWED_FILES.includes(f)) problems.push(`internal doc packed: ${f}`);
    if (!ALLOWED_FILES.includes(f) && !ALLOWED_DIRS.some((d) => f.startsWith(d))) problems.push(`unexpected file packed: ${f}`);
    if (KEY_SHAPE.test(readFileSync(join(dir, f), 'utf8'))) problems.push(`API key pattern (sk-ant-) found in: ${f}`);
  }
  return problems;
}

/** @param {string} text @returns {string | null} problem, or null if OK */
export function checkShebang(text) {
  return text.startsWith('#!/usr/bin/env node') ? null : 'missing "#!/usr/bin/env node" shebang';
}
