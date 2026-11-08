# Epic D · The web shell

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-d-web-shell` | `epic/d-shell` | `../onto-d` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 (plan from 0:00; build after Epic A's first drop) |

Read `LEAD.md` first, then Epic A's files on `main`, especially `web/shared/view.js`.

## Goal

One page that every view lives inside. The shell owns everything a reader touches apart from the drawing itself, so the 2D graph, the 3D stretch and any later view behave the same way:
- the same node menu, explain panel, search and filters;
- the same jobs tray, insight ticker, legend and view switcher;
- the same lens switcher and minimap corner.

## You own

- `web/index.html` (keep the `<!--importmap-->` comment in `<head>`: the server replaces it)
- `web/shell/`
- `test/d/`

**May touch:** nothing else.
**Must not touch:** `web/shared/`, `web/views/`, `web/dev/`, `src/`.

## Interface

### Where the data comes from

```js
// web/shell/source.js
export function createSource(params) {}
// returns { snapshot(), subscribe(fn) -> unsubscribe, act(action) -> Promise }
// The mode comes from the URL, so nothing ever needs switching:
// 'fixture' mode when the URL has ?fixture=<name>[&speed=<n>]: fetch /fixtures/<name>.events.jsonl
//      and replay it locally; act() applies view actions as local view.changed events and answers
//      job actions with job.queued then job.done after 1 s
// 'server' mode otherwise (pages served by `ontologizer`): start from emptyOntology() and fold
//      EventSource('/api/events?from=0'), which sends every stored event and then live ones.
//      Do NOT start from /api/snapshot: that double-counts, and a replay must grow from empty.
//      act() POSTs to /api/action (Epic B's action types, exactly)
// Both modes fold every event with fold() imported as '../../src/core/events.js' (relative, so the
// same file works in Node tests and in the browser).
```

Fixture mode lets you build the whole shell before Epic B's server lands. Serve it with `npm run dev` and open `/?fixture=plastic-modeling`.

### Feeding the layout and loading views

- `web/shell/main.js` imports `../views/index.js` (it registers every view that exists) and `../shared/layout/graph.js`. **Only `main.js` imports the views.** `source.js`, the layout feeder (`web/shell/feed.js`) and the other logic modules your tests import must never import `../views/index.js` or anything that touches the DOM, because Node has no `HTMLElement`.
- The shell creates one layout for the page and keeps it across view switches.
- For every event the shell does three things, in this order:
  1. folds the event;
  2. feeds the layout, exactly as `web/shared/view.js` says (`node.added` → `add`, `edge.added` → `addEdge`, `collapsed` → `setCollapsed`, `focus` → `setFocus`);
  3. calls `view.apply(event)`.
- Views never feed the layout.

### The page

```text
the view fills the page; chrome floats over it, dark theme by default, light theme supported
top bar      map name · search box · filter (categories, max depth) · view switcher · "See as" lens switcher
top right    minimap slot: the shell calls view.mountMinimap(slot) if the active view has it,
             otherwise the slot stays hidden
right        explain panel: opens on Explain, or when a node with an article is selected
bottom left  insight ticker: node hooks and insight events, one at a time, as they stream
bottom right jobs tray: queued, running, done, failed; click a job to focus its node
legend       categories with their colors (tokens.categoryColor), collapsible
```

### The node menu

The menu opens on `emit('select', { nodeId, x, y })` from the view, at `x, y`:

| Item | Shown when | Sends |
|---|---|---|
| Expand | the node is collapsed | `{ type: 'expand', nodeId }` |
| Collapse | the node has children and is open | `{ type: 'collapse', nodeId }` |
| Research (in context) | always | `{ type: 'research', nodeId, mode: 'context' }` |
| Research (general) | always | `{ type: 'research', nodeId, mode: 'general' }` |
| Explain | the node has no article yet | `{ type: 'explain', nodeId }` |
| Read explanation | the node has an article | opens the panel |
| Sources | always | `{ type: 'sources', nodeId }` |

Escape or a click elsewhere closes the menu.

### Wiring the active view

- **Views** come from `listViews()` (`web/shared/view.js`). The view switcher lists them; switching sends `{ type: 'layout', value: viewId }`.
- **Reload:** on load and on every `view.changed`, apply the view state to the active view:
  - the focus with `setFocus`,
  - the filter with `setFilter`,
  - the lens with `setLens`,
  - collapsed nodes, which the view handles from the events itself.
- **Search** is type-ahead over node labels: `view.highlight(matchIds)` and `view.setFocus(bestMatch)` on Enter. Escape clears the highlight.
- **Filters** send `{ type: 'filter', value }` and call `view.setFilter`.
- **The explain panel** shows, from the node's `article`:
  - the summary, key facts and why it matters;
  - "see also" links that focus those nodes;
  - sources as links that open in a new tab.

  While the node's explain job is running, it shows "Researching…".
- **The ticker** shows each new node's `hook` and each `insight` for about 4 s, newest first, at most one at a time.

## Work

- **W1: `source.js` (both modes), the layout feeding, and their tests.**
- **W2: `index.html`, the page layout, theme, top bar, legend, view switcher, view mounting.**
- **W3: the node menu, the explain panel, the jobs tray, the ticker.**
- **W4: search, filters, the lens switcher, the minimap slot.**
- **W5 (was Epic G's shell half): lens contents and fused-map styling.** Build and test it with hand-written events (a `lens.added` plus `lens.analog`s; categories with `family` 0, 1 and 2); it does not wait for Epic G.
  - The "See as" switcher lists `none` plus every lens in the snapshot. Choosing one sends `{ type: 'lens', value }` and calls `view.setLens`; `none` calls `view.setLens(null)`.
  - The explain panel shows the selected node's analog and its `breaks`, if a lens is active.
  - Fused maps: the legend groups categories by `family` (0, then 1, then Hybrids). Bridges and hybrids use the `bridge` edge style and the `fuse` outline from `tokens.js`; nothing else changes.

W1 first. Then W2. Then W3 and W4 in parallel.

## Checks: `npm run check:d`

Keep the logic in plain functions you can test in Node: menu items for a node, search matching, the view-state diff to apply. Keep DOM code thin.

| Check | Planted fault it must catch |
|---|---|
| Fixture mode replays the whole fixture and its snapshot equals `foldAll` of the fixture. | A source that skips `node.updated`. |
| `menuItems(node, ontology)` shows Expand only for collapsed nodes and Read explanation only when an article exists. | A menu that always shows Expand. |
| Every action the menu builds has a `type` that Epic B's server accepts. | A menu sending `type: 'explainNode'`. |
| Searching "cem" on the plastic-modeling fixture matches the plastic cement node, by label. | A search over ids instead of labels. |
| Switching views keeps focus, filter and lens (`viewStateToApply` returns all three). | A switch that resets the view state. |
| With a lens active and then set back to `none`, the shell calls `setLens(null)`, clearing every ghost label. | A switcher that never calls `setLens(null)`. |
| A snapshot with categories of families 0, 1 and 2 renders a legend in three groups, in that order. | A legend that ignores `family`. |
| Server mode folding a replayed event stream from 0 ends equal to `foldAll` of those events, with no category or insight counted twice. | A source that starts from `/api/snapshot` and then streams from 0. |
| Feeding the fixture through the shell's layout feeder leaves every node in `layout.positions()`, each exactly once. | A feeder that skips `node.added` for nodes whose parent has not arrived. |

## Try it

`npm run dev`, open `/?fixture=plastic-modeling&speed=4`:
- the map streams in once a view exists; before then, a placeholder says no view is registered;
- the ticker shows hooks;
- right-click or click a node: the menu opens, Explain shows a job in the tray, Collapse hides a branch;
- search finds a node.

After Epic B lands, `ontologizer load plastic-modeling --replay` shows the same page from the real server.

## Not in this epic

- No drawing of nodes or edges.
- No layout.
- No colors outside `tokens.js`.
- No editing of labels or links.
- No presence, sharing or accounts.

## Hand-offs

- **Epic E and F** are mounted by the shell through the view standard only. If a view needs something the standard does not have, it goes to Epic A, not to a special case here.
- **Epic B:** nothing to switch. Pages served by `ontologizer` have no `?fixture=` and use server mode automatically. Test server mode once B's server is on `main`.
- **Epic G:** its shell half is now your W5, above. Epic G's own session builds only the engine side.
