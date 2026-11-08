// @ts-check
import '../views/index.js';
import { getView, listViews } from '../shared/view.js';
import * as tokens from '../shared/tokens.js';
import { createGraphLayout } from '../shared/layout/graph.js';
import { fold, emptyOntology } from '../../src/core/events.js';

const q = new URLSearchParams(location.search);
const viewId = q.get('view') || 'none';
const fixture = q.get('fixture') || 'plastic-modeling';
const speed = Number(q.get('speed')) > 0 ? Number(q.get('speed')) : 1;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const entry = getView(viewId);
if (!entry) {
  const reg = listViews().map((v) => v.id);
  $('message').textContent = `No view registered with id "${viewId}". Registered: ${reg.length ? reg.join(', ') : 'none'}`;
}

let ontology = emptyOntology();
/** @type {Set<(e: object) => void>} */
const listeners = new Set();
const layout = createGraphLayout({ seed: 1, width: innerWidth, height: innerHeight });

const ctx = {
  snapshot: () => ontology,
  subscribe: (/** @type {(e: object) => void} */ fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  tokens,
  layout,
  emit: (/** @type {'select'|'hover'|'focus'} */ name, /** @type {object} */ detail) => {
    console.log('[emit]', name, detail);
    $('emit').textContent = `emit: ${name} ${JSON.stringify(detail)}`;
  },
};

/** @type {any} */
let view = null;
if (entry) {
  view = document.createElement(entry.elementName);
  $('stage').appendChild(view);
  view.mount($('stage'), ctx);
}

const res = await fetch(`/fixtures/${encodeURIComponent(fixture)}.events.jsonl`);
if (!res.ok) {
  $('message').textContent = `Fixture "${fixture}" not found (HTTP ${res.status})`;
  throw new Error(`fixture ${fixture}: ${res.status}`);
}
const events = (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
let done = 0;

function status() {
  $('overlay').textContent =
    `fixture: ${fixture}  view: ${viewId}  speed: ${speed}x\n` +
    `events: ${done}/${events.length}  nodes: ${Object.keys(ontology.nodes || {}).length}`;
}

/** @param {any} e */
function play(e) {
  ontology = fold(ontology, e);
  if (e.t === 'node.added') layout.add(e.node);
  else if (e.t === 'edge.added') layout.addEdge(e.edge);
  else if (e.t === 'view.changed' && e.patch) {
    if (e.patch.collapsed) layout.setCollapsed(e.patch.collapsed);
    if (e.patch.focus) layout.setFocus(e.patch.focus);
  }
  for (const fn of [...listeners]) fn(e);
  if (view) view.apply(e);
  done++;
  status();
}

status();
for (const e of events) setTimeout(() => play(e), (e.at || 0) / speed);
