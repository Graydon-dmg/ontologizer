# Contributing to Ontologizer

Thanks for helping. Pull requests are welcome. In the description, say what changed and how you checked it.

**Licence of contributions.** Ontologizer is licensed under the [MIT licence](LICENSE). Anything you submit is licensed under the same MIT terms. There is no CLA to sign. The Ontologizer name and logo are trademarks, not covered by the code licence; see [TRADEMARKS.md](TRADEMARKS.md).

## Set up

You need Node 22 or newer.

```bash
git clone https://github.com/Graydon-dmg/ontologizer.git
cd ontologizer
npm install
npm run check      # every offline test; no API key, no network, well under a minute
npm run dev        # the dev harness: prints a URL
```

Run the CLI from your clone, with a throwaway data folder so you never touch your real maps:

```bash
ONTOLOGIZER_HOME=$(mktemp -d) node src/cli/index.js --help
```

Maps live in `~/.ontologizer` by default; `ONTOLOGIZER_HOME` moves them.

### Live checks (optional, cost a few cents)

`npm run check:c:live` calls the real API. The tests skip themselves when `ANTHROPIC_API_KEY` is not set. To pass a key stored in the macOS keychain to one command only:

```bash
ANTHROPIC_API_KEY=$(security find-generic-password -s ontologizer -a anthropic-api-key -w) npm run check:c:live
```

The key stays in that one command's environment. Never echo it, and never paste it into a file, a log, an issue or a PR.

## The folder map

| Path | What lives there |
|---|---|
| `src/core/` | `schema.js` (data shapes), `events.js` (event types and `fold`), `store.js` (on-disk store), `vendor.js` |
| `src/core/engine/` | The engine: `build.js` (context check and streaming build), `jobs.js` (research, explain, sources), `queue.js`, `call.js`, `jsonl.js`, `ids.js`, `prompts.js`, `fuse.js` and `rosetta.js` (with `prompts-g.js`) |
| `src/cli/` | The `ontologizer` command: `index.js`, `main.js`, `apikey.js`, `notice.js`, and one file per command in `commands/` |
| `src/server/` | The local web server (`index.js`) |
| `web/shell/` | The page every view lives in: menus, panels, search, filters, jobs tray, legend |
| `web/shared/` | The view standard (`view.js`), colors and styles (`tokens.js`), the shared layout (`layout/graph.js`), the browser import map (`importmap.json`) |
| `web/views/graph/` | The 2D graph view |
| `web/views/sky/` | The 3D "Floor and Sky" view |
| `web/dev/` | The dev harness page (served by `scripts/dev-server.js`) |
| `fixtures/` | Recorded maps (`*.events.jsonl`) used by tests and the harness |
| `test/<area>/` | Tests, one folder per area: `a` core and shared, `b` CLI/store/server, `c` engine (`c/live` calls the API), `d` shell, `e` 2D graph, `f` 3D, `g` fuse and rosetta, `h` packaging |
| `scripts/` | `test.js` (test runner) and `dev-server.js` |
| `docs/contracts/` | The build contracts the project was made from. Start with `README.md`; `epic-a-contract.md` describes the shared pieces |

## The idea in one paragraph

A map is an append-only log of events (`ontology.created`, `node.added`, `edge.added`, `job.done`, and so on). One function, `fold` in `src/core/events.js`, turns that log into the current map. The engine only writes new events, and only through the store. Views only draw what the events say and report clicks back. Nothing else changes a map.

## Adding a view

A view is a custom element. The shell owns all menus and panels; the view only draws and reports clicks. The full standard is in `web/shared/view.js`. Every view implements:

- `mount(el, ctx)`: `ctx` has `snapshot()`, `subscribe(fn)`, `tokens`, `layout` and `emit(name, detail)`
- `apply(event)`: update incrementally, never redraw everything per event
- `setFocus(nodeId)`, `setLens(lensId)`, `setFilter(filter)`, `highlight(nodeIds)` (`[]` clears)
- `unmount()`
- optional `mountMinimap(el)`

Rules:

- The page creates one shared layout and feeds it. A view only reads `ctx.layout.positions()` and listens with `ctx.layout.on('tick', fn)`.
- Take colors and styles only from `web/shared/tokens.js`.
- Register with `registerView(id, label, elementName)`.

Put the view in its own folder, `web/views/<name>/index.js`. A minimal skeleton, following the pattern `web/views/graph/index.js` uses:

```js
// @ts-check
// <onto-list>: an example view that lists node labels.
import { registerView } from '../../shared/view.js';

const Base = globalThis.HTMLElement ?? class {};

class OntoList extends Base {
  /** @type {import('../../shared/view.js').ViewContext|null} */ ctx = null;
  /** @type {HTMLElement|null} */ root = null;

  /** @param {HTMLElement} el @param {import('../../shared/view.js').ViewContext} ctx */
  mount(el, ctx) {
    this.ctx = ctx;
    this.root = el;
    this.draw();
  }
  draw() {
    if (!this.ctx || !this.root) return;
    const nodes = Object.values(this.ctx.snapshot().nodes);
    this.root.textContent = nodes.map((n) => n.label).join(', ');
  }
  /** @param {{ t: string }} event */
  apply(event) { if (event.t === 'node.added') this.draw(); }
  /** @param {string} _nodeId */
  setFocus(_nodeId) {}
  /** @param {string|null} _lensId */
  setLens(_lensId) {}
  /** @param {{ categories: string[]|null, maxDepth: number|null }} _filter */
  setFilter(_filter) {}
  /** @param {string[]} _nodeIds */
  highlight(_nodeIds) {}
  unmount() { if (this.root) this.root.textContent = ''; this.ctx = null; this.root = null; }
}

if (globalThis.customElements) {
  customElements.define('onto-list', OntoList);
  registerView('list', 'List', 'onto-list');
}
```

Then add `import './list/index.js';` to `web/views/index.js` next to the `graph` and `sky` imports.

Try it in the harness: run `npm run dev`, open the printed URL, and change the path to `/dev/?view=list&fixture=plastic-modeling`. The harness replays a fixture into your view. Full form: `/dev/?view=<id>&fixture=<name>&speed=<n>` (`speed` divides the event timing; fixtures are the names in `fixtures/`, without `.events.jsonl`). If the id is not registered the page says so.

## Adding a test (with a planted fault)

Tests are `node:test` files named `*.test.js` under `test/<area>/`. `npm run check` finds them all; `npm run check:<area>` (`check:a` to `check:h`) runs one folder. Files in a `live/` folder run only with `LIVE=1`.

Every check must also prove it can fail. Write the check as a function that returns a list of problems, assert it returns none for good input, then feed it a deliberately broken input (a planted fault) and assert it reports a problem. `test/g/fuse.test.js` and `test/a/tokens.test.js` do this. A short example in the same style:

```js
// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldAll } from '../../src/core/events.js';

/** @param {{ nodes: Record<string, { parent: string|null }> }} o */
function checkParents(o) {
  /** @type {string[]} */
  const problems = [];
  for (const [id, n] of Object.entries(o.nodes)) {
    if (n.parent !== null && !o.nodes[n.parent]) problems.push(`parent ${n.parent} of ${id} is missing`);
  }
  return problems;
}

const events = readFileSync(new URL('../../fixtures/manga.events.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

test('the manga fixture has no orphan nodes', () => {
  assert.deepEqual(checkParents(foldAll(events)), []);
});

test('planted fault: dropping a parent is reported', () => {
  const child = events.find((e) => e.t === 'node.added' && e.node.parent !== null);
  const faulty = events.filter((e) => !(e.t === 'node.added' && e.node.id === child.node.parent));
  assert.ok(checkParents(foldAll(faulty)).length > 0);
});
```

A check whose planted fault passes is not a check; fix it before you trust it.

## Rules

- `npm run check` must pass before every PR.
- No secrets in git: no API keys in files, logs, events or fixtures.
- Plain JavaScript ES modules with JSDoc types and `// @ts-check` at the top of each file. No build step.
- Relative imports (`../../shared/tokens.js`), so one file works in Node tests and in the browser.
- Colors and styles come from `web/shared/tokens.js`, nowhere else.

## Releases

Releases are published from GitHub Actions with npm trusted publishing, with provenance. See [docs/RELEASING.md](docs/RELEASING.md).
