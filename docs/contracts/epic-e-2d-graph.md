# Epic E · The 2D graph view (mandatory)

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-e-2d-graph` | `epic/e-graph` | `../onto-e` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 (plan from 0:00; build after Epic A's first drop) |

Read `LEAD.md` first, then Epic A's files on `main`: `web/shared/view.js`, `tokens.js`, `layout/graph.js`.

## Goal

The baseline view and the centerpiece of the demo: a node-link graph where every node and every link is visible and draggable.
- **The hierarchy still reads,** through depth rings around the focus and colored category sectors.
- **New nodes spring out of their parents** as the build streams in.
- **A minimap in the top-right corner** shows the whole map and where you are, so a deep zoom never loses the reader.

## You own

- `web/views/graph/` (Epic A leaves a placeholder `web/views/graph/index.js`. Replace it with the file that defines `<onto-graph>` and calls `registerView('graph-2d', '2D graph', 'onto-graph')`. Guard both with `if (globalThis.customElements)`, so importing the file in Node never throws.)
- `test/e/`

**May touch:** nothing else.
**Must not touch:** `web/views/index.js` (it already imports `./graph/index.js`), `web/shared/` (ask S0 for layout or token changes), `web/shell/`, `web/index.html`, `src/`.

## Interface

`<onto-graph>` implements the view standard from `web/shared/view.js`, and nothing more:

```text
mount(el, ctx)      SVG with layers: links, nodes, halos, labels. d3-zoom on the SVG (zoom 0.2 to 4).
                    Draws every node already in ctx.snapshot() at ctx.layout.positions(), then
                    redraws positions on ctx.layout's 'tick'. The view only READS the layout: the
                    page has already fed it (add, addEdge, setCollapsed, setFocus) before apply().
apply(event)
  node.added        draw the node starting at its parent's position, springing out to its layout
                    position (MOTION.spawnMs); its link draws in with it
  node.updated      restyle: status, article mark (a filled core with a small page glyph),
                    sources outline (dotted when it has no sources)
  edge.added        a curved link colored by edgeStyle(type)
  view.changed      collapsed -> hide the subtree, "+N" badge on the collapsed node;
                    focus -> setFocus
  job.queued/started  pulsing halo on the job's node;  job.done/failed  halo off
  lens.added/analog and setLens: a ghost label under each node with an analog; ⚠ where it breaks
setFocus(id)        animate the zoom transform so the focus is centered (MOTION.focusMs)
setFilter(f)        hide filtered nodes and their links (they stay in the layout)
highlight(ids)      ids and their neighbors bright; everything else at MOTION.hoverDim opacity;
                    [] clears
mountMinimap(el)    a small SVG of the whole graph: dots in category colors, no labels, no links.
                    A rectangle shows the current viewport. Click or drag in the minimap pans the
                    main view. Redraw on zoom, and on layout ticks at most 10 times a second.
unmount()

emits               select on click (with the screen x, y); hover on mouseenter/mouseleave
                    (nodeId or null); focus on double-click
encodings           fill: tokens.categoryColor(category.index, category.family), lightened by
                    depthLightness(depth); radius: nodeRadius(descendants); outline: originOutline
labels              always for the focus, the first LABEL_RULE.alwaysDepth rings from the focus and
                    the hovered node; deeper labels appear when zoom k >= LABEL_RULE.zoomForDeeper
drag                dragging a node pins it (fx, fy) while dragging and releases it on drop
```

Put the logic you can test in `web/views/graph/math.js`, and keep the custom element thin:

```js
export function neighborhood(nodeId, ontology) {}            // Set of ids: node, parent, children, cross-linked
export function viewportRect(transform, viewSize, worldBounds, miniSize) {} // minimap rectangle
export function panFromMinimap(point, worldBounds, miniSize, viewSize, k) {} // the new transform
export function labelVisible(node, ctx) {}                   // the label rule above
export function descendants(nodeId, ontology) {}             // count, honoring nothing hidden
```

## Work

- **W1: `math.js` and its tests.**
- **W2: the element.** Mount, the SVG layers, encodings, `node.added` spawn animation, `edge.added`, zoom, drag, and the select, hover and focus emits.
- **W3: focus animation, collapse badges, `setFilter`, `highlight`, job halos, the article mark, lens ghost labels.**
- **W4: the minimap.**

W1 and W2 in parallel. Then W3 and W4 in parallel.

The lead's job is the look. Tune it on the harness until the build is a pleasure to watch:
- spring timing;
- link curvature;
- label legibility;
- the strength of the category and ring pulls.

Force strengths live in `web/shared/layout/graph.js`. Ask S0 for changes, with the numbers you want.

## Checks: `npm run check:e`

Run in Node against the fixture, using `math.js`. No browser needed. The layout's own behavior (stability on add, nodes that arrive before their parent) is Epic A's to check. If your tuning on the harness shows a layout problem, send S0 the numbers you want.

| Check | Planted fault it must catch |
|---|---|
| `descendants` of the Tools category equals the number of nodes under it in the fixture. | A count that includes the node itself. |
| `neighborhood` of a node includes its parent, children and cross-linked nodes, and nothing else. | A neighborhood that leaves out cross-links. |
| `viewportRect` matches the visible region after a zoom to k = 2 centered on a known point. | A rectangle that ignores the zoom scale. |
| `panFromMinimap` then `viewportRect` round-trips: clicking a minimap point centers the view there. | A pan that ignores the minimap's scale. |
| `labelVisible` hides a depth-3 node at k = 1 and shows it at k = 2. | A rule that shows every label. |

## Try it

`npm run dev`, then open `/dev/?view=graph-2d&fixture=plastic-modeling&speed=2`:
- categories appear, children spring out of them sector by sector, and links draw in;
- zoom into one corner: the minimap rectangle shrinks to that corner; drag the rectangle and the view follows;
- hovering dims everything but the neighborhood; clicking logs a `select` emit.

After Epic D lands, `/?fixture=plastic-modeling` shows the same thing inside the shell.

## Not in this epic

- No fisheye; the minimap gives the overview instead.
- No hierarchical edge bundling: a later view could add it.
- No WebGL and no canvas, unless SVG is clearly too slow with the fixture, which it should not be.
- No menus or panels: those belong to the shell.

## Hand-offs

- **Epic F** reads the same layout. Any force change you get from S0 moves the 3D view too, which is intended.
- **The dev harness and the shell** both feed the layout before calling `apply`. If a node has no position in `ctx.layout.positions()` when you draw it, that is a feeding bug in the page, not something to work around in the view: report it to the human.
- **Epic D** mounts you through the standard and calls `mountMinimap` with its top-right slot.
