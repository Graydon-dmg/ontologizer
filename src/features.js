// @ts-check
// Every Epic I feature has a command and a button on the localhost page (issue #1).
// `cli` is the yargs command name; `ui.id` is an element id on `ui.page` (in its html, or rendered
// by the shell modules that page loads).
/** @typedef {{ id: string, epic: string, cli: string, ui: { page: string, id: string } }} Feature */

/** @type {Feature[]} */
export const FEATURES = [
  { id: 'export', epic: 'I4', cli: 'export', ui: { page: 'web/index.html', id: 'export' } },
  { id: 'export-context', epic: 'I4', cli: 'export', ui: { page: 'web/index.html', id: 'export-context' } },
];
