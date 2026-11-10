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

/** What a front-door doc lacks for an agent to discover the whole system. @param {string} text */
export async function discoverabilityGaps(text) {
  const { MCP_OPS, PROMPTS } = await import('../../src/server/mcp.js');
  const need = [
    // As code, the way an agent types them: a passing mention in prose doesn't count.
    ...MCP_OPS.map((/** @type {any} */ o) => `\`${o.mcp.name}\``),
    ...PROMPTS.map((/** @type {any} */ p) => `\`${p.name}\``),
    'claude mcp add', '"mcpServers"', '--token-file', 'claude mcp list',
  ];
  return need.filter((n) => !text.includes(n));
}

test('FOR-AGENTS.md names every MCP tool and prompt, and says how to install and check the MCP server', async () => {
  assert.deepEqual(await discoverabilityGaps(read('FOR-AGENTS.md')), []);
});

test('planted fault: a front door that leaves out a tool, a prompt or the install check is reported', async () => {
  const cut = read('FOR-AGENTS.md').replaceAll('`rosetta`', 'rosetta').replaceAll('`deepen-a-node`', 'deepen-a-node').replaceAll('claude mcp list', '');
  assert.deepEqual((await discoverabilityGaps(cut)).sort(), ['`deepen-a-node`', '`rosetta`', 'claude mcp list']);
});

test('the README Install section and the agent install guide both say how to add and check the MCP server', () => {
  const readme = read('README.md');
  const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('## Your first map'));
  for (const s of ['claude mcp add ontologizer', '"mcpServers"', 'claude mcp list']) assert.ok(install.includes(s), `README Install: ${s}`);
  const guide = read('docs/AGENT-INSTALL.md');
  for (const s of ['claude mcp add ontologizer', '"mcpServers"', 'claude mcp list', 'FOR-AGENTS.md']) assert.ok(guide.includes(s), `AGENT-INSTALL: ${s}`);
});
