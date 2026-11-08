# Epic F · The 3D Floor and Sky view (stretch)

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-f-3d-sky` | `epic/f-sky` | `../onto-f` | Opus 5.5 | Sonnet 5.5 | 0:15 to 2:10 (plan from 0:00; build after Epic A's first drop) |

Read `LEAD.md` first, then Epic A's files on `main`.

## Goal

The stretch view: the 2D graph's own positions laid on a floor, with cross-links rising as arcs above it. Structure sits below and relations above. A fused map shows as two islands with bridges between them.

This epic is a stretch. Its rule beyond `LEAD.md`: **it never blocks or breaks the 2D view.**
- **Do not land on `main` before 2:10.** Push your branch to GitHub as you go (`git push origin HEAD`).
- **At 2:10, tell the human whether your checks pass and `npm run check` is green with `main` merged in.** The human decides. Land only if the human says land.

## You own

- `web/views/sky/` (Epic A leaves a placeholder `web/views/sky/index.js`. Replace it with the file that defines `<onto-sky>` and calls `registerView('sky-3d', '3D', 'onto-sky')`. Guard both with `if (globalThis.customElements)`, so importing the file in Node never throws.)
- `test/f/`

**May touch:** nothing else.
**Must not touch:** `web/views/index.js` (it already imports `./sky/index.js`), `web/shared/`, `web/shell/`, `web/views/graph/`, `src/`.

## Interface

`<onto-sky>` implements the view standard from `web/shared/view.js`:

```text
mount(el, ctx)      three.js scene: WebGLRenderer, PerspectiveCamera, OrbitControls
                    (import from 'three/addons/controls/OrbitControls.js'), CSS2DRenderer for labels
                    ('three/addons/renderers/CSS2DRenderer.js'). Slow auto-rotation is on by default
                    (about 0.5 rpm) and stops while the user drags; it resumes after 5 s idle.
positions           ctx.layout.positions(): layout (x, y) maps to world (x, 0, y), scaled to fit.
                    Read only: the page feeds the layout before apply(). On mount, draw every node
                    already in ctx.snapshot(), then follow the layout's 'tick'.
nodes               spheres; color and size from the same tokens as the 2D view
cross-links         quadratic Bezier arcs from node to node; apex height = 40 * treeDistance(from, to);
                    color from edgeStyle(type)
apply(event)        the same events as the 2D view: spawn at the parent, restyle on node.updated,
                    halos for jobs, ghost labels for a lens
setFocus(id)        the camera target glides to the node
setFilter, highlight, setLens   the same behavior as the 2D view
emits               select (click, via raycast; the screen x, y of the click), hover, focus (double-click)
mountMinimap        not implemented (optional in the standard)
```

Keep the testable logic in `web/views/sky/math.js`. It must not import `three`, so the tests run in Node without WebGL:

```js
export function toWorld(pos, bounds, size) {}        // layout (x, y) -> [x, 0, z]
export function treeDistance(a, b, ontology) {}      // hops through the common ancestor
export function arcPoints(from, to, height, n = 24) {} // points along the arc
```

## Work

- **W1: `math.js` and its tests.**
- **W2: the scene, controls, auto-rotation, nodes from the layout, labels.**
- **W3: arcs, spawn animation, focus, filter, highlight, halos, raycast select and hover.**

W1 and W2 in parallel. Then W3.

## Checks: `npm run check:f`

| Check | Planted fault it must catch |
|---|---|
| `toWorld` of every settled fixture position equals the 2D layout's position after the documented mapping (the floor matches the 2D view). | A view that runs its own layout. |
| `treeDistance` of two siblings is 2; of a node and its grandparent, 2; of nodes in different categories, through the root. | A distance that counts only depth. |
| `arcPoints` starts at `from`, ends at `to`, and peaks at the given height. | An arc whose apex ignores the height. |

**Manual checks, by the lead, before landing:**
- the fixture replays at 30 frames per second or better on the demo laptop;
- a click in 3D opens the same shell menu as in 2D;
- switching from 2D to 3D and back keeps focus and filter.

## Try it

`npm run dev`, then open `/dev/?view=sky-3d&fixture=plastic-modeling&speed=2`: the floor fills sector by sector, arcs rise for cross-links, and the scene turns slowly.

## Not in this epic

- No VR and no stereo.
- Not the default view.
- The animated 2D-to-3D tilt transition is the first thing to cut. Build it only if everything else has landed by 1:50.

## Hand-offs

- **The human** decides at 2:10. If the answer is land: run the full landing steps in `LEAD.md`. If the answer is no: leave the branch on GitHub and do not land it.
- **Epic D** lists the view automatically once `web/views/index.js` registers it.
