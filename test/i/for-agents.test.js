// @ts-check
// FOR-AGENTS.md is the front door for agents: it exists, every link in it resolves, and the README
// and AGENTS.md point to it near their top.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Relative links in a markdown file that point to a missing file or heading. @param {string} file @param {string} text */
export function brokenLinks(file, text) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue;
    const [rel, anchor] = href.split('#');
    const target = path.join(path.dirname(path.join(ROOT, file)), rel);
    if (!fs.existsSync(target)) { out.push(href); continue; }
    if (anchor && target.endsWith('.md')) {
      const slugs = fs.readFileSync(target, 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l))
        .map((l) => l.replace(/^#+ /, '').trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-'));
      if (!slugs.includes(anchor)) out.push(href);
    }
  }
  return out;
}

test('FOR-AGENTS.md exists and every link in it resolves', () => {
  assert.deepEqual(brokenLinks('FOR-AGENTS.md', read('FOR-AGENTS.md')), []);
});

test('planted fault: a missing file and a missing heading are reported', () => {
  assert.deepEqual(brokenLinks('FOR-AGENTS.md', '[a](docs/NOPE.md) [b](docs/GUIDE.md#99-nothing)'), ['docs/NOPE.md', 'docs/GUIDE.md#99-nothing']);
});

test('README (first 20 lines) and AGENTS.md (first 3 lines) point to FOR-AGENTS.md', () => {
  assert.ok(read('README.md').split('\n').slice(0, 20).join('\n').includes('FOR-AGENTS.md'), 'README');
  assert.ok(read('AGENTS.md').split('\n').slice(0, 3).join('\n').includes('FOR-AGENTS.md'), 'AGENTS.md');
});

test('the README lists every top-level command the CLI registers', async () => {
  const { COMMANDS } = await import('../../src/cli/main.js');
  const readme = read('README.md');
  const hidden = new Set(['complete', '__complete']);
  // `start` is the default command: the README lists it as plain `ontologizer`.
  const listed = (/** @type {string} */ c) => (c === 'start' ? readme.includes('`ontologizer` |') : readme.includes(`ontologizer ${c}`));
  const missing = COMMANDS.filter((/** @type {string} */ c) => !hidden.has(c) && !listed(c));
  assert.deepEqual(missing, []);
});
