// @ts-check
// The commands that connect an agent to the map tools (no DOM). It never takes or shows a real
// token: the HTTP forms carry a placeholder, and a real one comes from `ontologizer token create`.

export const TOKEN_PLACEHOLDER = '<YOUR_TOKEN>';

/**
 * @param {{ serverUrl: string, service: boolean }} o serverUrl: the page's origin; service: service mode
 * @returns {{ http: string|null, stdio: string, json: string }}
 */
export function agentConfigs({ serverUrl, service }) {
  const url = `${String(serverUrl ?? '').replace(/\/+$/, '')}/v1/mcp`;
  const server = service
    ? { type: 'http', url, headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } }
    : { command: 'npx', args: ['-y', 'ontologizer', 'mcp'] };
  return {
    http: service ? `claude mcp add --transport http ontologizer ${url} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"` : null,
    stdio: 'claude mcp add ontologizer -- npx -y ontologizer mcp',
    json: JSON.stringify({ mcpServers: { ontologizer: server } }, null, 2),
  };
}

export const CONNECT_INTRO = 'Give an agent (Claude Code, the Agent SDK, any MCP client) the map tools: outline, search, research, ask…';
export const TOKEN_NOTE = 'The token comes from `ontologizer token create`; it is never shown here.';
export const SERVE_NOTE = 'The HTTP form needs `ontologizer serve`; this page is a single map.';
