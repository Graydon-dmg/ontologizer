# Shell internals (Epic D only)

Logic modules (Node-testable: no DOM, never import ../views/index.js):

| File | Exports | Owner |
|---|---|---|
| source.js | createSource(params) -> { mode, snapshot(), subscribe(fn) -> unsub, act(action) -> Promise, done: Promise } | W1 |
| feed.js | feedLayout(layout, event) | W1 |
| actions.js | ACTION_TYPES, isValidAction(a), viewPatchFor(action, ontology) | W1 |
| viewstate.js | viewStateToApply(view) -> { focus, filter, lens }; applyViewState(viewEl, state) | W2 |
| legend.js | legendGroups(ontology, tokens) -> [{ family, title, items: [{ id, label, color }] }]; fusedSwatches(ontology, tokens) | W2 |
| menu.js | menuItems(node, ontology) -> [{ id, label, action?, open? }] | W3 |
| explain.js | explainModel(ontology, nodeId) -> { node, article, researching, analog } | W3 |
| jobs.js | jobRows(ontology) | W3 |
| ticker.js | tickerItem(event, ontology) -> { text, nodeId } \| null; createTicker({ show, setTimeout, clearTimeout, holdMs }) | W3 |
| search.js | searchNodes(ontology, query, limit) -> ids | W4 |
| lens.js | lensOptions(ontology); lensSelection(value) -> { action, setLensArg }; analogFor(ontology, nodeId) | W4 |

DOM modules: each exports `mountX(el, shell)` and is called once by main.js.

| File | Slot id | Owner |
|---|---|---|
| ui/views.js mountViewSwitcher | #view-switcher | W2 |
| ui/height.js mountHeight | #height-switcher (shown only while the view implements setHeight) | 1.8 |
| ui/legend.js mountLegend | #legend | W2 |
| ui/menu.js mountMenu | #menu | W3 |
| ui/explain.js mountExplain | #explain | W3 |
| ui/jobs.js mountJobs | #jobs | W3 |
| ui/ticker.js mountTicker | #ticker | W3 |
| ui/search.js mountSearch | #search | W4 |
| ui/filter.js mountFilter | #filter | W4 |
| ui/lens.js mountLens | #lens-switcher | W4 |
| ui/minimap.js mountMinimap | #minimap | W4 |

CSS: shell.css (W2: page, top bar, legend, switcher, theme vars), panels.css (W3), controls.css (W4).
Use only CSS variables set by main.js from tokens.THEME: --bg --fg --muted --panel. Category colors
come from tokens.categoryColor only.

## The shell object (built by main.js, passed to every mountX)

```js
shell = {
  source,                 // from createSource
  snapshot(),             // = source.snapshot()
  act(action),            // = source.act(action)
  layout,                 // the one layout for the page
  tokens,                 // web/shared/tokens.js namespace
  views,                  // listViews()
  activeView(),           // mounted view element or null
  activeViewId(),         // string|null
  switchView(id),         // mounts that view (keeps layout); sends { type:'layout', value:id }
  on(name, fn) -> off,    // shell bus
  emit(name, detail),
  openExplain(nodeId),    // = emit('explain', { nodeId })
  heightMode(),           // 'off'|'learning'|'coverage'|'connectedness' (set by ui/height.js)
}
```

Bus names:
- `event`   { event, ontology }   after fold + feedLayout + view.apply, for every source event
- `select`  { nodeId, x, y }       from the view (nodeId null = background click)
- `hover`   { nodeId }             from the view
- `focus`   { nodeId }             from the view (main.js also sends { type:'focus', nodeId })
- `view`    { id, view }           after a view is mounted (view null if none registered)
- `explain` { nodeId }             open the explain panel on that node
- `height`  { mode }               the 3D Height choice changed (ui/height.js calls view.setHeight first)
