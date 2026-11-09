// @ts-check
// The html and embed formats: the map as data plus the inlined embed bundle, nothing loaded from
// anywhere. Pure: no Node or DOM, so the CLI and the page share it.

/** @typedef {import('../schema.js').Ontology} Ontology */

/**
 * The snapshot an html or embed export carries: the map as /api/snapshot returns it, minus the chat
 * (questions people asked are not part of a published map) and minus jobs that never finished (a
 * static page cannot finish them).
 * @param {Ontology} ontology
 * @returns {Ontology}
 */
export function exportSnapshot(ontology) {
  /** @type {Ontology['jobs']} */
  const jobs = {};
  for (const [id, j] of Object.entries(ontology.jobs || {})) {
    if (j && (j.state === 'done' || j.state === 'failed')) jobs[id] = j;
  }
  return { ...ontology, jobs, chat: [] };
}

/**
 * JSON safe inside a <script> element: `<` becomes < (no `</script>`, no `<!--`), and the two
 * line separators JavaScript once treated as newlines are escaped too. Still valid JSON.
 * @param {unknown} value
 * @returns {string}
 */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * A script body safe inside a classic <script> element: any `</script` is broken up.
 * `<\/` means the same as `</` in JavaScript strings, templates and regular expressions.
 * @param {string} code
 * @returns {string}
 */
export function scriptCode(code) {
  // `<!--` then `<script` would put the parser in its "double escaped" state, where the real
  // </script> no longer ends the element. The build refuses such a bundle; this is the second guard.
  const found = ['<!--', '<script'].filter((t) => String(code).toLowerCase().includes(t));
  if (found.length) throw new Error(`The embed bundle contains ${found.map((t) => `"${t}"`).join(' and ')} and cannot be inlined in a <script> safely (the build refuses such a bundle).`);
  return String(code).replace(/<\/(script)/gi, '<\\/$1');
}

/** @param {string} s */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * liveUrl as an attribute value, or null when it is not an ordinary web link.
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function liveHref(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** @param {Ontology} ontology */
const isPrivate = (ontology) => /** @type {any} */ (ontology).visibility === 'private';

/**
 * The light-DOM children of <ontologizer-map> shared by both formats: the Private banner and the
 * "Open live" link (the one link an export may carry).
 * @param {Ontology} ontology
 * @param {string|null} liveUrl
 */
function slots(ontology, liveUrl) {
  const out = [];
  if (isPrivate(ontology)) out.push('<div slot="banner" class="ontologizer-private">Private: this map cites private sources. Keep it inside its audience.</div>');
  const href = liveHref(liveUrl);
  if (href) out.push(`<a slot="live" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open live</a>`);
  return out;
}

/** @param {string|undefined} bundle */
function needBundle(bundle) {
  if (typeof bundle !== 'string' || !bundle.trim()) {
    throw new Error('The html and embed formats need the embed bundle (web/dist/embed.js): run `npm run build`.');
  }
  return bundle;
}

/**
 * One self-contained page: the map in #ontologizer-data, one <ontologizer-map> filling the window,
 * the bundle inlined in a classic <script>.
 * @param {Ontology} ontology
 * @param {{ bundle?: string, liveUrl?: string|null }} opts
 * @returns {string}
 */
export function htmlPage(ontology, { bundle, liveUrl = null } = {}) {
  const code = needBundle(bundle);
  const title = ontology.name ? `${ontology.name} · Ontologizer` : 'Ontologizer';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    // No colors here: the element paints the whole window from the shared tokens.
    '<style>html,body{margin:0;height:100%}ontologizer-map{position:fixed;inset:0}</style>',
    '</head>',
    '<body>',
    `<script type="application/json" id="ontologizer-data">${scriptJson(exportSnapshot(ontology))}</script>`,
    `<ontologizer-map aria-label="${escapeHtml(ontology.name || 'Map')}">${slots(ontology, liveUrl).join('')}</ontologizer-map>`,
    `<script>${scriptCode(code)}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * A fragment to drop into any page: one <ontologizer-map> with its own data tag, then the bundle.
 * Several on one page work: the bundle only defines the element once.
 * @param {Ontology} ontology
 * @param {{ bundle?: string, liveUrl?: string|null }} opts
 * @returns {string}
 */
export function embedFragment(ontology, { bundle, liveUrl = null } = {}) {
  const code = needBundle(bundle);
  const inner = [
    ...slots(ontology, liveUrl),
    `<script type="application/json" class="ontologizer-data">${scriptJson(exportSnapshot(ontology))}</script>`,
  ];
  return [
    `<ontologizer-map style="display:block;height:480px" aria-label="${escapeHtml(ontology.name || 'Map')}">`,
    ...inner,
    '</ontologizer-map>',
    `<script>${scriptCode(code)}</script>`,
    '',
  ].join('\n');
}
