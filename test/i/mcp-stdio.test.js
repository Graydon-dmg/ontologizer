// @ts-check
// W3: `ontologizer mcp` over stdio, in-process and against a live server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { boot, tempHome } from './helpers-service.js';

process.env.ONTOLOGIZER_STUB_SPEED = '200'; // the live server's stub engine builds fast
const CLI = new URL('../../src/cli/index.js', import.meta.url).pathname;
const ENV = {
  PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ONTOLOGIZER_ENGINE: 'stub', ONTOLOGIZER_STUB_SPEED: '200',
  ONTOLOGIZER_KEYRING: 'none', ONTOLOGIZER_NO_UPDATE_CHECK: '1',
};

/** Problems in a captured stdout: every line must be JSON-RPC. @param {string} out */
export function stdoutProblems(out) {
  /** @type {string[]} */
  const p = [];
  for (const line of out.split('\n').filter(Boolean)) {
    let j;
    try { j = JSON.parse(line); } catch { p.push(`not JSON: ${line.slice(0, 60)}`); continue; }
    if (!j || j.jsonrpc !== '2.0') p.push(`not JSON-RPC: ${line.slice(0, 60)}`);
  }
  return p;
}

/** A transport that records what the child writes to stdout. @param {string[]} args */
function recording(args) {
  const t = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', ...args], env: ENV, stderr: 'ignore' });
  let raw = '';
  const orig = t.start.bind(t);
  t.start = async () => { await orig(); /** @type {any} */ (t)._process?.stdout?.on('data', (/** @type {Buffer} */ c) => { raw += c.toString('utf8'); }); };
  return { t, raw: () => raw };
}

/** @param {Client} c @param {string} id */
async function waitIdle(c, id) {
  for (let i = 0; i < 60; i++) {
    const w = /** @type {any} */ (await c.callTool({ name: 'wait_for_map', arguments: { id, timeout: 5000 } }));
    if (w.structuredContent?.state === 'idle') return;
  }
  throw new Error('the map never became idle');
}

/** @param {Client} c */
async function roundTrip(c) {
  const checked = /** @type {any} */ (await c.callTool({ name: 'check_context', arguments: { context: 'plastic recycling' } }));
  assert.ok(!checked.isError, JSON.stringify(checked.content));
  const built = /** @type {any} */ (await c.callTool({ name: 'build_map', arguments: { brief: checked.structuredContent.brief } }));
  assert.ok(!built.isError, JSON.stringify(built.content));
  const { id } = built.structuredContent;
  await waitIdle(c, id);
  const outline = /** @type {any} */ (await c.callTool({ name: 'get_outline', arguments: { id } }));
  assert.ok(outline.content[0].text.includes('Plastic modeling'), `the outline names the root: ${outline.content[0].text.slice(0, 80)}`);
}

test('stdio round trip: build_map, wait_for_map, get_outline; stdout is only JSON-RPC', async () => {
  const home = tempHome();
  const { t, raw } = recording(['--home', home]);
  const c = new Client({ name: 'test', version: '1' });
  try {
    await c.connect(t);
    const { tools } = await c.listTools();
    assert.equal(tools.length, 16);
    await roundTrip(c);
  } finally { await c.close(); }
  assert.ok(raw().length > 0);
  assert.deepEqual(stdoutProblems(raw()), []);
  // planted: a log line on stdout must be reported
  assert.ok(stdoutProblems(`${raw()}Serving 0 maps at http://127.0.0.1:1\n`).some((x) => /not JSON/.test(x)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('--url with --token-file reaches a token server; ONTOLOGIZER_TOKEN works too', async () => {
  const { srv, origin, secrets, home } = await boot({ tokens: [{ name: 'agent', scopes: ['read', 'build'] }] });
  const file = path.join(home, 'agent.token');
  fs.writeFileSync(file, `${secrets.agent}\n`);
  try {
    {
      const { t, raw } = recording(['--url', origin, '--token-file', file]);
      const c = new Client({ name: 'test', version: '1' });
      try { await c.connect(t); await roundTrip(c); } finally { await c.close(); }
      assert.deepEqual(stdoutProblems(raw()), []);
    }
    {
      const t = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--url', origin], env: { ...ENV, ONTOLOGIZER_TOKEN: secrets.agent }, stderr: 'ignore' });
      const c = new Client({ name: 'test', version: '1' });
      try { await c.connect(t); const r = /** @type {any} */ (await c.callTool({ name: 'list_maps', arguments: {} })); assert.ok(!r.isError, JSON.stringify(r.content)); } finally { await c.close(); }
    }
    {
      // no token: the server's own refusal, as a tool error
      const t = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--url', origin], env: ENV, stderr: 'ignore' });
      const c = new Client({ name: 'test', version: '1' });
      try { await c.connect(t); const r = /** @type {any} */ (await c.callTool({ name: 'list_maps', arguments: {} })); assert.equal(r.isError, true); } finally { await c.close(); }
    }
  } finally { await srv.close(); }
});

test('there is no --token flag: it exits non-zero', () => {
  const r = spawnSync(process.execPath, [CLI, 'mcp', '--token', 'x'], { env: ENV, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});
