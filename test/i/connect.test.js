// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConfigs, TOKEN_PLACEHOLDER } from '../../web/shell/connect.js';
import { usageLines } from '../../web/shell/server-panel.js';
import { MENU_ITEMS as EXPORT_ITEMS } from '../../web/shell/ui/export.js';

const TOKEN_SHAPE = /ont_[A-Za-z0-9_-]{43}/;
const URL = 'http://127.0.0.1:4802';

/** Problems with a configs function: token-shaped strings, or an Authorization header without the placeholder.
 * @param {(o: { serverUrl: string, service: boolean }) => { http: string|null, stdio: string, json: string }} make @returns {string[]} */
function configProblems(make) {
  const problems = [];
  for (const service of [true, false]) {
    const c = make({ serverUrl: URL, service });
    for (const [k, v] of Object.entries(c)) {
      if (v === null) continue;
      if (TOKEN_SHAPE.test(v)) problems.push(`${k} (service ${service}) holds a token`);
      for (const m of v.matchAll(/Authorization": "([^"]*)"|Authorization: ([^"]*)"/g)) {
        if (!(m[1] ?? m[2]).endsWith(`Bearer ${TOKEN_PLACEHOLDER}`)) problems.push(`${k}: Authorization is not the placeholder`);
      }
    }
  }
  return problems;
}

test('agentConfigs gives the exact commands', () => {
  const c = agentConfigs({ serverUrl: URL, service: true });
  assert.equal(c.http, `claude mcp add --transport http ontologizer ${URL}/v1/mcp --header "Authorization: Bearer <YOUR_TOKEN>"`);
  assert.equal(c.stdio, 'claude mcp add ontologizer -- npx -y ontologizer mcp');
  assert.equal(c.json, JSON.stringify({ mcpServers: { ontologizer: { type: 'http', url: `${URL}/v1/mcp`, headers: { Authorization: 'Bearer <YOUR_TOKEN>' } } } }, null, 2));
  const one = agentConfigs({ serverUrl: URL, service: false });
  assert.equal(one.http, null);
  assert.equal(one.stdio, c.stdio);
  assert.equal(one.json, JSON.stringify({ mcpServers: { ontologizer: { command: 'npx', args: ['-y', 'ontologizer', 'mcp'] } } }, null, 2));
  assert.equal(agentConfigs({ serverUrl: `${URL}/`, service: true }).http, c.http);
});

test('no output holds a token, and the header holds only the placeholder', () => {
  assert.deepEqual(configProblems(agentConfigs), []);
});

test('planted fault: a configs function that embeds a token is reported', () => {
  const tok = `ont_${'A'.repeat(43)}`;
  const bad = (/** @type {{ serverUrl: string, service: boolean }} */ o) => {
    const c = agentConfigs(o);
    return { ...c, json: c.json.replace(TOKEN_PLACEHOLDER, tok) };
  };
  assert.ok(configProblems(bad).length > 0);
  const badHttp = (/** @type {{ serverUrl: string, service: boolean }} */ o) => {
    const c = agentConfigs(o);
    return { ...c, http: c.http && c.http.replace(TOKEN_PLACEHOLDER, 'secret') };
  };
  assert.ok(configProblems(badHttp).length > 0);
});

test('usageLines with and without limits', () => {
  const u = { day: '2026-11-09', calls: 1234, inputTokens: 1000, outputTokens: 500, limits: { calls: null, tokens: null }, resetsAt: 'x' };
  assert.deepEqual(usageLines(u), ['Today (UTC): 1,234 model calls, 1,500 tokens']);
  assert.deepEqual(usageLines({ ...u, limits: { calls: 100, tokens: 50000 } }), ['Today (UTC): 1,234 model calls, 1,500 tokens', 'Limits: 100 calls, 50,000 tokens a day']);
  assert.deepEqual(usageLines({ ...u, limits: { calls: 100, tokens: null } })[1], 'Limits: 100 calls a day');
  assert.deepEqual(usageLines(null), []);
});

/** @param {{ id: string }[]} items @returns {string[]} */
function menuProblems(items) {
  const want = ['export-html', 'export-embed', 'export-json', 'export-context', 'export-obsidian', 'connect-agent'];
  const got = items.map((i) => i.id);
  return JSON.stringify(got) === JSON.stringify(want) ? [] : [`menu is ${got.join(', ')}`];
}

test('the Export menu is the exports, then Connect an agent', () => {
  assert.deepEqual(menuProblems([...EXPORT_ITEMS]), []);
  assert.equal(EXPORT_ITEMS.at(-1)?.label, 'Connect an agent…');
});

test('planted fault: a menu without connect-agent is reported', () => {
  assert.equal(menuProblems(EXPORT_ITEMS.filter((i) => i.id !== 'connect-agent')).length, 1);
});
