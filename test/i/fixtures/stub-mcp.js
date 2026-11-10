// @ts-check
// A tiny MCP server for tests: stdio when run directly, or buildStubServer() for InMemoryTransport.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const CORPUS = [
  ['glue', 'Choosing glue', 'Liquid cement welds styrene; thin it with a brush for clean seams. Use gel glue for small parts.'],
  ['paint', 'Paint types', 'Acrylic paint thins with water, enamel with spirit. Prime first for a smooth coat.'],
  ['sanding', 'Sanding seams', 'Work through grits from coarse to fine to remove seam lines and sprue marks.'],
  ['decals', 'Applying decals', 'Soak the decal, slide it into place, then seal with a gloss coat and a setting solution.'],
  ['airbrush', 'Airbrushing basics', 'Thin paint to the consistency of milk and keep a steady pressure for even coverage.'],
  ['weathering', 'Weathering a model', 'Use washes and dry brushing to show wear, dust and chipped paint.'],
  ['masking', 'Masking tape tips', 'Burnish the edge of the tape and remove it slowly to keep paint lines sharp.'],
  ['clippers', 'Cutting parts from the sprue', 'Cut slightly away from the part, then trim the nub flush with a sharp blade.'],
];

/** Calls the write tool received, in memory (for the in-memory server). @type {string[]} */
export const calls = [];

/** @param {{ name?: string }} [o] */
export function buildStubServer({ name = 'wiki' } = {}) {
  const docs = CORPUS.map(([id, title, text]) => ({ ref: `doc-${id}`, title, url: `https://${name}.example/doc-${id}`, snippet: text, text }));
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'search', description: 'Search the documents.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'get', description: 'Get one document.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] }, annotations: { readOnlyHint: true } },
      { name: 'delete_page', description: 'Delete a page.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: 'secret_search', description: 'Search restricted documents.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: tool, arguments: args = {} } = req.params;
    if (tool === 'search' || tool === 'secret_search') {
      const q = String(args.query ?? '').toLowerCase();
      let hits = docs.filter((d) => q && `${d.title} ${d.text}`.toLowerCase().includes(q));
      if (!hits.length) hits = docs;
      const results = hits.map(({ ref, title, url, snippet }) => ({ ref, title, url, snippet }));
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }], structuredContent: { results } };
    }
    if (tool === 'get') {
      const d = docs.find((x) => x.ref === args.ref);
      if (!d) return { isError: true, content: [{ type: 'text', text: 'No such document.' }] };
      return { content: [{ type: 'text', text: d.text }, { type: 'resource_link', uri: d.url, name: d.ref, title: d.title }] };
    }
    if (tool === 'delete_page') {
      calls.push(String(args.ref ?? ''));
      if (process.env.STUB_MCP_CALLS) fs.appendFileSync(process.env.STUB_MCP_CALLS, `delete_page ${args.ref ?? ''}\n`);
      return { content: [{ type: 'text', text: 'Deleted.' }] };
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown tool ${tool}` }] };
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const i = process.argv.indexOf('--name');
  const server = buildStubServer({ name: i > 0 ? process.argv[i + 1] : 'wiki' });
  await server.connect(new StdioServerTransport());
}
