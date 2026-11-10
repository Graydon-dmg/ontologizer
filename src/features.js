// @ts-check
// Every Epic I feature, with its CLI command and its button on the localhost page (issue #1: "any new
// features have a button on the localhost and a command-line function"). test/i/features.test.js
// fails if a command is not registered or a button's element id is not in its page.
// `cli` is the yargs command name; `ui.id` is an element id in `ui.page`.

export const FEATURES = [
  { id: 'serve',   epic: 'I1', cli: 'serve',   ui: { page: 'web/home/index.html', id: 'new-map' } },
  { id: 'status',  epic: 'I1', cli: 'status',  ui: { page: 'web/home/index.html', id: 'server-panel' } },
  { id: 'token',   epic: 'I1', cli: 'token',   ui: { page: 'web/home/index.html', id: 'server-tokens' } },
  { id: 'new-map-from-map', epic: 'I1', cli: 'serve', ui: { page: 'web/index.html', id: 'brand-menu' } },
  { id: 'sources-picker', epic: 'I2', cli: 'sources', ui: { page: 'web/home/index.html', id: 'sources-picker' } },
  { id: 'private-badge',  epic: 'I2', cli: 'list',    ui: { page: 'web/index.html',      id: 'private-badge' } },
  { id: 'source-refs',    epic: 'I2', cli: 'sources', ui: { page: 'web/index.html',      id: 'node-sources' } },
  { id: 'sources-status', epic: 'I2', cli: 'status',  ui: { page: 'web/home/index.html', id: 'server-sources' } },
  { id: 'export', epic: 'I4', cli: 'export', ui: { page: 'web/index.html', id: 'export' } },
  { id: 'export-context', epic: 'I4', cli: 'export', ui: { page: 'web/index.html', id: 'export-context' } },
  { id: 'mcp', epic: 'I3', cli: 'mcp', ui: { page: 'web/index.html', id: 'connect-agent' } },
  { id: 'mcp-home', epic: 'I3', cli: 'mcp', ui: { page: 'web/home/index.html', id: 'server-connect-agent' } },
  { id: 'api', epic: 'I3', cli: 'serve', ui: { page: 'web/home/index.html', id: 'server-api' } },
  { id: 'usage', epic: 'I3', cli: 'usage', ui: { page: 'web/home/index.html', id: 'server-usage' } },
  // I5 · Manage maps. Back to the maps home has no command of its own: `list` is the command line's view of the maps.
  { id: 'back-to-home', epic: 'I5', cli: 'list',    ui: { page: 'web/index.html',      id: 'all-maps' } },
  { id: 'rename',       epic: 'I5', cli: 'save',    ui: { page: 'web/index.html',      id: 'map-rename' } },
  { id: 'delete',       epic: 'I5', cli: 'delete',  ui: { page: 'web/index.html',      id: 'map-delete' } },
  { id: 'trash',        epic: 'I5', cli: 'trash',   ui: { page: 'web/home/index.html', id: 'trash-list' } },
  { id: 'restore',      epic: 'I5', cli: 'restore', ui: { page: 'web/home/index.html', id: 'trash-section' } },
];
