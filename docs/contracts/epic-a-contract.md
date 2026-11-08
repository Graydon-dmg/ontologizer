# Epic A · The contract

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-a-contract` | `epic/a-contract` | `../onto-a` | Opus 5.5 | Sonnet 5.5 | 0:00 to 0:25 (two drops), then on call for contract changes |

Read `LEAD.md` first.

## Goal

Give every other epic the same foundation, so that five sessions can build in parallel from minute 15 without waiting for each other:
- the data model and the one function that turns events into a map;
- the event types;
- the view standard, the visual tokens and the shared layout;
- two recorded fixture maps;
- a dev harness that lets a view render the fixture with no server and no shell;
- the complete `package.json`.

Nothing in this epic draws a real view, calls the model at run time, or touches disk outside the repository.

## The product in brief (for context)

`ontologizer` is a command-line tool, installed with `npm i -g ontologizer`. `ontologizer new` asks for context (what you want to explore and why), checks it is enough to build from, then opens a local web page where a map of the topic grows live as an LLM builds it. Each node can be expanded, collapsed, researched further or explained. Maps are saved on disk as an event log, reload exactly as they were, can be fused in pairs, and can be seen through an analogy lens ("Rosetta"). The 2D graph view is the baseline; a 3D view is a stretch.

## You own

- `package.json`, `.gitignore`, `LICENSE` (MIT), `.claude/settings.json`, `CLAUDE.md`
- `src/core/schema.js`, `src/core/events.js`, `src/core/index.js`, `src/core/vendor.js`
- `web/shared/` (view standard, tokens, layout, import map)
- `web/views/index.js`
- the six placeholder files below. You create them once; their epics own and replace them afterwards, so no two epics ever edit the same file:

| Placeholder | Contents | Then owned by |
|---|---|---|
| `src/core/store.js` | `export function openStore() { throw new Error('store: not built yet'); }` | Epic B |
| `src/core/engine/index.js` | `export function createEngine() { throw new Error('engine: not built yet'); }` | Epic C |
| `src/core/engine/fuse.js` | `export async function fuse() { throw new Error('fuse: not built yet'); }` | Epic G |
| `src/core/engine/rosetta.js` | `export async function rosetta() { throw new Error('rosetta: not built yet'); }` | Epic G |
| `web/views/graph/index.js` | `// Epic E registers the 2D graph view here.` | Epic E |
| `web/views/sky/index.js` | `// Epic F registers the 3D view here.` | Epic F |

`src/core/index.js` re-exports schema, events, `openStore` and `createEngine`. `web/views/index.js` imports `./graph/index.js` and `./sky/index.js`, and exports `listViews` from `../shared/view.js`. Neither file changes again.
- `web/dev/` and `scripts/dev-server.js` (the dev harness), `scripts/test.js` (the test runner)
- `fixtures/`
- `test/a/`

**May touch:** nothing else.
**Must not touch:** `src/cli/`, `src/server/`, `web/shell/`, `web/index.html`, or the six placeholders once their epics have changed them.

## Interface

Everything below is relied on by other epics. Write it exactly. A change after the first drop needs a message to every lead (through the human).

### Language and layout

- Plain JavaScript ES modules, `"type": "module"`, JSDoc types with `// @ts-check` at the top of every file. No TypeScript, no build step, no bundler.
- Node 20 or newer.

```text
package.json
CLAUDE.md                     short: "read docs/contracts/LEAD.md and your epic's contract"
.claude/settings.json         allows npm, node, git and file edits without prompting
src/core/schema.js            JSDoc typedefs (below)
src/core/events.js            fold, foldAll, emptyOntology, makeEvent
src/core/index.js             re-exports schema/events (and later store/engine)
src/core/store.js             (Epic B)
src/core/engine/              (Epic C)
src/cli/                      (Epic B)
src/server/                   (Epic B)
web/index.html                (Epic D)
web/shell/                    (Epic D)
web/shared/view.js            view registry and the view standard
web/shared/tokens.js          the only source of colors and styles
web/shared/layout/graph.js    the shared, seeded force layout
web/shared/importmap.json     bare module names -> /vendor/ paths
web/dev/index.html, dev.js    the dev harness page
web/views/graph/              (Epic E)
web/views/sky/                (Epic F)
scripts/dev-server.js         static server for the harness, with /vendor and /fixtures
fixtures/plastic-modeling.events.jsonl
fixtures/manga.events.jsonl
test/<epic>/*.test.js         node --test files, one folder per epic
docs/contracts/               these files
```

### package.json

```json
{
  "name": "ontologizer",
  "version": "0.1.0",
  "description": "Give it a topic and watch the whole field draw itself: a live, color-coded map of any topic, built by an LLM.",
  "type": "module",
  "bin": { "ontologizer": "src/cli/index.js" },
  "exports": {
    ".": "./src/core/index.js",
    "./core": "./src/core/index.js",
    "./views": "./web/views/index.js"
  },
  "files": ["src", "web", "fixtures", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "license": "MIT",
  "scripts": {
    "check": "node scripts/test.js test",
    "check:a": "node scripts/test.js test/a",
    "check:b": "node scripts/test.js test/b",
    "check:c": "node scripts/test.js test/c",
    "check:c:live": "LIVE=1 node scripts/test.js test/c/live",
    "check:d": "node scripts/test.js test/d",
    "check:e": "node scripts/test.js test/e",
    "check:f": "node scripts/test.js test/f",
    "check:g": "node scripts/test.js test/g",
    "check:h": "node scripts/test.js test/h",
    "dev": "node scripts/dev-server.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "@inquirer/prompts": "latest",
    "@napi-rs/keyring": "latest",
    "open": "latest",
    "p-queue": "latest",
    "yargs": "latest",
    "d3-color": "latest", "d3-dispatch": "latest", "d3-drag": "latest", "d3-ease": "latest",
    "d3-force": "latest", "d3-interpolate": "latest", "d3-quadtree": "latest", "d3-selection": "latest",
    "d3-timer": "latest", "d3-transition": "latest", "d3-zoom": "latest",
    "three": "latest"
  }
}
```
Run `npm install` once, then replace every `"latest"` with the installed version range (`^x.y.z`) so every session installs the same versions. Create `test/b` through `test/h` with an empty `.gitkeep` so every script runs from minute one.

`scripts/test.js <folder>` finds every `*.test.js` under the folder, skips any `live/` folder unless `LIVE=1`, and runs `node --test <files…>`. It exits 0 when there are no files. It behaves the same on every Node version from 20 up, which folder and glob arguments to `node --test` do not.

`.claude/settings.json` lets the build sessions work without permission prompts:

```json
{ "permissions": { "allow": ["Bash(npm:*)", "Bash(node:*)", "Bash(npx:*)", "Bash(git:*)",
                             "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Edit", "Write"] } }
```

**Imports are relative everywhere** (`../../shared/tokens.js`, `../../src/core/events.js`), so one file works both in Node tests and in the browser. The servers serve `web/` at `/` and `src/core/` at `/src/core/`, and a browser resolves `../` past the site root to the root, so the same relative paths resolve in both.

### src/core/schema.js

```js
// @ts-check
/** @typedef {{ context: string, subject: string, scope: string, purpose: string,
 *              level: 'beginner'|'intermediate'|'expert' }} Brief */
/** @typedef {{ title: string, url: string }} Source */
/** @typedef {{ summary: string, keyFacts: string[], whyItMatters: string,
 *              seeAlso: string[], sources: Source[] }} Article */
/** @typedef {{ id: string, label: string, parent: string|null, category: string, depth: number,
 *              summary?: string, hook?: string,
 *              origin: 'seed'|'context'|'general'|'fuse'|'rosetta',
 *              sources: Source[], article: Article|null, status: 'pending'|'done',
 *              createdBy: string }} OntoNode
 *   id is the path slug of labels from the root: "plastic-modeling/tools/adhesives".
 *   parent is null only for the root. depth: root 0, categories 1, and so on.
 *   category is the id of the node's top-level category: normally its depth-1 ancestor (a category's own
 *   category is itself; the root's is ""). In a fused map, copied nodes keep their source map's category
 *   so colors and sectors survive fusion; the two source roots have category "".
 *   createdBy names the pass that made it: "wave0", "wave1", "research", "fuse", ... */
/** @typedef {{ id: string, from: string, to: string,
 *              type: 'influences'|'requires'|'part-of'|'bridge'|'analog', why: string }} OntoEdge
 *   Edges are cross-links only. Parent links are implied by node.parent, never stored as edges. */
/** @typedef {{ id: string, persona: string,
 *              analogs: Record<string, { label: string, breaks?: string }> }} Lens */
/** @typedef {{ collapsed: string[], focus: string, layout: string, lens: string|null,
 *              filter: { categories: string[]|null, maxDepth: number|null } }} ViewState */
/** @typedef {{ id: string, label: string, index: number, family: number }} Category
 *   index: 0-based order of appearance; family: 0 normally, 1 for the second map in a fusion,
 *   2 for the Hybrids category of a fused map. */
/** @typedef {{ name: string, root: string, version: 1, brief: Brief, categories: Category[],
 *              nodes: Record<string, OntoNode>, edges: OntoEdge[],
 *              lenses: Record<string, Lens>, view: ViewState,
 *              jobs: Record<string, { id: string, kind: string, nodeId?: string,
 *                                     state: 'queued'|'running'|'done'|'failed', error?: string }>,
 *              insights: { at: number, text: string, nodeId?: string }[] }} Ontology */
export {};
```

### src/core/events.js

Every line of `events.jsonl` is one event. `at` is milliseconds since the ontology was created.

```js
// @ts-check
/** OntoEvent:
 *  { t: 'ontology.created', at, name, root, brief, categories: [] }   always the first event
 *  { t: 'category.added', at, category }
 *  { t: 'node.added', at, node }
 *  { t: 'node.updated', at, id, patch }            shallow merge into the node
 *  { t: 'edge.added', at, edge }
 *  { t: 'view.changed', at, patch }                shallow merge into view (filter merges one level deeper)
 *  { t: 'lens.added', at, lens }                   lens.analogs may start empty
 *  { t: 'lens.analog', at, lensId, nodeId, label, breaks? }
 *  { t: 'job.queued'|'job.started'|'job.done'|'job.failed', at, job: { id, kind, nodeId?, error? } }
 *  { t: 'insight', at, text, nodeId? }
 *  { t: 'ontology.renamed', at, name }             written by save
 */
export function emptyOntology() {}        // a valid Ontology with no nodes; view defaults below
export function fold(ontology, event) {}  // pure: returns a NEW ontology; never mutates; never reads the clock
export function foldAll(events) {}        // fold from emptyOntology()
export function makeEvent(t, fields, startedAt) {} // { t, at: Date.now() - startedAt, ...fields }
// Unknown event types are ignored (forward compatible). A node.added whose parent is missing is
// still folded; views must tolerate a parent that arrives later.
// View defaults: { collapsed: [], focus: <root>, layout: 'graph-2d', lens: null,
//                  filter: { categories: null, maxDepth: null } }
```

### web/shared/view.js: the view standard

```js
// @ts-check
// A view is a custom element. The shell owns all interaction chrome (menus, panels, search,
// filters, jobs tray, ticker, legend, view switcher). A view only draws, hit-tests and emits.
//
// The layout is fed by the page, never by a view. The shell (and the dev harness) creates ONE
// layout per page. For every event it first updates the layout, then calls view.apply(event):
//   node.added -> layout.add(node)      edge.added -> layout.addEdge(edge)
//   view.changed with collapsed -> layout.setCollapsed(ids); with focus -> layout.setFocus(id)
// The layout survives view switches. A newly mounted view draws every node already in
// ctx.snapshot() at ctx.layout.positions(), then follows layout ticks. Views only READ the layout.
/** @typedef {{
 *   snapshot: () => import('../../src/core/schema.js').Ontology,
 *   subscribe: (fn: (e: object) => void) => () => void,
 *   tokens: typeof import('./tokens.js'),
 *   layout: ReturnType<typeof import('./layout/graph.js').createGraphLayout>,
 *   emit: (name: 'select'|'hover'|'focus', detail: { nodeId: string|null, x?: number, y?: number }) => void
 * }} ViewContext */
// Every view element implements:
//   mount(el: HTMLElement, ctx: ViewContext): void
//   apply(event): void                 incremental update; never a full redraw per event
//   setFocus(nodeId: string): void
//   setLens(lensId: string|null): void
//   setFilter(filter: { categories: string[]|null, maxDepth: number|null }): void
//   highlight(nodeIds: string[]): void  [] clears
//   mountMinimap?(el: HTMLElement): void  optional
//   unmount(): void
export function registerView(id, label, elementName) {}
export function listViews() {}           // [{ id, label, elementName }]
```

### web/shared/tokens.js: the only source of colors and styles

```js
// @ts-check
export function categoryColor(index, family = 0) {}  // 12 distinct hues; family 1 = a shifted set for the
                                                     // second map in a fusion; family 2 = one neutral hue (Hybrids)
export function depthLightness(depth) {}             // lighter with each ring, clamped
export function nodeRadius(descendants) {}           // 5 + 3 * log2(1 + descendants), capped at 22
export function edgeStyle(type) {}                    // { color, width, dash: number[]|null, curve: number }
export function originOutline(origin, sourced) {}    // { stroke, dash: number[]|null, double: boolean }
                                                     //   context: solid; general: dashed; fuse: double;
                                                     //   rosetta: solid thin; unsourced: dotted
export const LABEL_RULE = { alwaysDepth: 2, zoomForDeeper: 1.6 };
export const MOTION = { spawnMs: 450, focusMs: 700, hoverDim: 0.15 };
// Colors must read on a dark background (the page is dark by default) and on light.
```

### web/shared/layout/graph.js: one seeded layout for every view

```js
// @ts-check
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceRadial } from 'd3-force';
export function createGraphLayout({ seed = 1, width = 1000, height = 800 } = {}) {}
// Returns:
//   add(node)                 place a new node at its parent's position plus a seeded jitter;
//                             reheat gently (alpha 0.3, never 1) so placed nodes barely move
//   addEdge(edge)             cross-link: weak link force
//   setFocus(id)              radial force re-centered on the focus by graph distance
//   setCollapsed(ids)         hidden subtrees leave the simulation; their positions are kept
//   positions()               Map<id, { x, y }>
//   on('tick', fn) / off('tick', fn)
//   settle(ticks = 300)       run synchronously (tests, replays)
//   stop()
// Forces: parent link (strong, short), cross-link (weak, long), many-body charge, collide by
// node radius, radial by depth from the focus (ring spacing 90), and an angular pull toward the
// node's category sector (sectors split 360 degrees in category order).
// Determinism: all randomness comes from a seeded PRNG (mulberry32(seed)); never Math.random.
// A node whose parent has not arrived yet starts at the center and is re-placed when its parent
// arrives. Nodes with category "" (roots) get no angular pull.
```

### web/shared/importmap.json

```json
{ "imports": {
  "d3-color": "/vendor/d3-color/src/index.js",
  "d3-dispatch": "/vendor/d3-dispatch/src/index.js",
  "d3-drag": "/vendor/d3-drag/src/index.js",
  "d3-ease": "/vendor/d3-ease/src/index.js",
  "d3-force": "/vendor/d3-force/src/index.js",
  "d3-interpolate": "/vendor/d3-interpolate/src/index.js",
  "d3-quadtree": "/vendor/d3-quadtree/src/index.js",
  "d3-selection": "/vendor/d3-selection/src/index.js",
  "d3-timer": "/vendor/d3-timer/src/index.js",
  "d3-transition": "/vendor/d3-transition/src/index.js",
  "d3-zoom": "/vendor/d3-zoom/src/index.js",
  "three": "/vendor/three/build/three.module.js",
  "three/addons/": "/vendor/three/examples/jsm/"
} }
```
Check each path against the installed packages and correct it if a package keeps its ES module entry elsewhere.

Any server serves `/vendor/<pkg>/<path>` from that package's folder. Find the folder by resolving the package's entry, `createRequire(import.meta.url).resolve('<pkg>')`, then walking up to the nearest folder whose `package.json` has `"name": "<pkg>"`. Do not resolve `'<pkg>/package.json'` directly: d3 and three do not export it (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Put this lookup in `src/core/vendor.js` as `export function packageDir(pkg) -> absolute folder path`. Both the dev server and Epic B's server import it. It lives under `src/` so it ships in the npm package; `scripts/` does not ship.

### The dev harness

- `npm run dev` starts `scripts/dev-server.js` on a free port and prints the URL. It serves:
  - `web/` at `/`,
  - `/vendor/`,
  - `/fixtures/`,
  - `/src/core/` (so the browser can import `fold`).

  It inlines `importmap.json` into any HTML page where the comment `<!--importmap-->` appears.
- `web/dev/index.html?view=<id>&fixture=<name>&speed=<n>`:
  1. loads `web/views/index.js` (which registers every view that exists);
  2. mounts the chosen view full-page with a stub context and one shared layout;
  3. replays the fixture with its `at` timing divided by `speed`. For each event it folds the event, feeds the layout (see `view.js`), then calls `view.apply`.

  The stub context logs `emit` calls to the console and shows the last one in a corner. If no view with that id is registered, the page says so.

### Fixtures

- `fixtures/plastic-modeling.events.jsonl`: a realistic map for this brief, written by a worker directly (no API call):

  > Scale plastic modeling for a complete beginner getting into it as a hobby: kits, tools, techniques, community, history.

  It holds:
  - the root,
  - 8 categories, including Tools,
  - the path Tools › Adhesives › Plastic cement, with CA glue and PVA glue next to Plastic cement. Other epics' checks and the demo script use these nodes.
  - 70 to 100 nodes in total (depth up to 3),
  - 15 to 25 cross-links of mixed types,
  - a `hook` on every node,
  - two `insight` events,
  - `at` values spread over about 25 seconds in build order: categories first, then children category by category, then cross-links.
- `fixtures/manga.events.jsonl`: a smaller map for "Japanese manga for a curious beginner": root, 6 categories, 30 to 40 nodes, 8 cross-links. Epic G uses it to test fusion.

## Work

**Drop 1, land by about 0:15** (others are waiting for it):
- **W1 (worker): `package.json`, `scripts/test.js`, `.gitignore`, `LICENSE`, `.claude/settings.json`, `CLAUDE.md`, the empty `test/*` folders.** Done when `npm install` and `npm run check` run.
- **W2 (worker): `src/core/schema.js`, `src/core/events.js`, `src/core/index.js`, the store, engine, fuse and rosetta placeholders, `test/a/events.test.js`.** Done when the checks below for `fold` pass.
- **W3 (worker): both fixtures and `test/a/fixtures.test.js`.** Done when the fixture checks pass.

**Drop 2, land by about 0:25:**
- **W4 (worker): `web/shared/tokens.js`, `web/shared/view.js`, `test/a/tokens.test.js`.**
- **W5 (worker): `web/shared/layout/graph.js`, `test/a/layout.test.js`.**
- **W6 (worker): `web/shared/importmap.json`, `src/core/vendor.js`, `scripts/dev-server.js`, `web/dev/`, `web/views/index.js`, and the graph and sky placeholders.** Done when `npm run dev` serves the harness and a throwaway test view (kept out of the commit) can import `d3-force` through the import map.

Run W1 to W3 in parallel, then W4 to W6 in parallel.

## Checks: `npm run check:a`

| Check | Planted fault it must catch |
|---|---|
| Both fixtures fold into valid ontologies: every node's parent exists by the end, every edge's ends exist, ids are unique, every node has a category that is a category id. | A fixture line naming a parent that never appears. |
| `fold` is pure: folding the same events twice gives deep-equal results, and the input ontology is unchanged after a fold. | A `fold` that writes `Date.now()` into the map, or mutates its input. |
| `view.changed` with `{ filter: { maxDepth: 2 } }` keeps `filter.categories`. | A shallow merge that wipes `categories`. |
| The layout is seeded: two layouts fed the same fixture with the same seed agree to within 1 px after `settle()`. | A layout that uses `Math.random`. |
| At least 80% of each category's nodes sit within that category's angular sector after `settle()`. | A layout with the angular force removed. |
| Adding one node to a settled layout moves no other node more than 20 px. | A full-energy reheat (alpha 1) on add. |
| A node added before its parent ends with finite x and y once the parent arrives and the layout settles. | A child placed at its missing parent's position (NaN). |
| `/vendor/d3-force/src/index.js` and `/vendor/three/build/three.module.js` resolve to real files through `packageDir()` in `src/core/vendor.js`. | Resolving `'<pkg>/package.json'`, which d3 does not export. |
| Every token function returns a value for category indexes 0 to 11, families 0, 1 and 2, every origin, and every edge type. | A missing `rosetta` outline. |

## Try it

```bash
npm install && npm run check && npm run dev
```
Open the printed URL at `/dev/?view=none&fixture=plastic-modeling`: the harness loads, replays the fixture and reports that no view is registered yet.

## Not in this epic

- No store, no server beyond the dev harness, no model calls at run time, no real views.

## Hand-offs

- After drop 1, tell the train lead (`lead`): "Epic A drop 1 is on main." It tells every lead to merge `main`.
- After drop 2, the same for drop 2.
- After that, you are the owner of the contract: answer change requests from other leads quickly. Add optional fields rather than renaming. Land each change alone, with a commit message that starts `contract:`.
- Epic H has its own session (`epic-h-ship`); this session stays on call for contract changes until the freeze.
