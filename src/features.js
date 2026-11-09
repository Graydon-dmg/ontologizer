// @ts-check
// Every Epic I feature, with its CLI command and its button on the localhost page (issue #1: "any new
// features have a button on the localhost and a command-line function"). test/i/features.test.js
// fails if a command is not registered or a button's element id is not in its page.
// `cli` is the yargs command name; `ui.id` is an element id in `ui.page`.

export const FEATURES = [
  { id: 'serve',   epic: 'I1', cli: 'serve',   ui: { page: 'web/home/index.html', id: 'new-map' } },
  { id: 'status',  epic: 'I1', cli: 'status',  ui: { page: 'web/home/index.html', id: 'server-panel' } },
  { id: 'token',   epic: 'I1', cli: 'token',   ui: { page: 'web/home/index.html', id: 'server-tokens' } },
  { id: 'sources-picker', epic: 'I2', cli: 'sources', ui: { page: 'web/home/index.html', id: 'sources-picker' } },
  { id: 'private-badge',  epic: 'I2', cli: 'list',    ui: { page: 'web/index.html',      id: 'private-badge' } },
  { id: 'source-refs',    epic: 'I2', cli: 'sources', ui: { page: 'web/index.html',      id: 'node-sources' } },
  { id: 'sources-status', epic: 'I2', cli: 'status',  ui: { page: 'web/home/index.html', id: 'server-sources' } },
];
