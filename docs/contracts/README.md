# Ontologizer build contracts

These files are the build plan for Ontologizer, an open-source command-line tool that builds a live, color-coded map of everything inside a topic and streams it into a local web page as it goes. They are written so that a Claude Code session can pick up one file and build its part without asking anyone.

Copy this folder into the repository as `docs/contracts/` before the clock starts (see `HUMAN.md`).

## What is in here

| File | Who reads it | What it is |
|---|---|---|
| `HUMAN.md` | The person running the build | Setup, accounts, starting the sessions, the clock, npm publishing, the demo. |
| `LEAD.md` | Every epic lead | How a lead works: workers, checking every body of work, branches, landing on `main`. |
| `epic-a-contract.md` | `epic-a-contract` | The shared contract: schema, events, view standard, tokens, layout, fixtures, dev harness. |
| `epic-b-cli-store-server.md` | `epic-b-cli-store-server` | The `ontologizer` command, the on-disk store, the local server. |
| `epic-c-engine.md` | `epic-c-engine` | The context check, the streaming build, research, explain, sources, the job queue. |
| `epic-d-web-shell.md` | `epic-d-web-shell` | The page every view lives in: menu, panels, search, filters, view switcher. |
| `epic-e-2d-graph.md` | `epic-e-2d-graph` | The 2D graph view, with minimap. Mandatory. |
| `epic-f-3d-sky.md` | `epic-f-3d-sky` | The 3D "Floor and Sky" view. Stretch. |
| `epic-g-fuse-rosetta.md` | `epic-g-fuse-rosetta` | Fusing two maps; the Rosetta analogy lens. |
| `epic-h-ship.md` | `epic-h-ship` | README, package contents, release preparation, demo replay. |

## The sessions

Each epic has one **lead** session and any number of **workers**. Workers run one model tier below the lead. The lead personally checks every body of work before it is accepted (`LEAD.md`).

Every epic has its own Claude Code session, named after its contract file. A **train lead** session (`lead`) runs the whole build by `LEAD.md`: it briefs each epic lead, checks every body of work before it lands, and keeps `main` green.

| Session name | Epic | Branch | Worktree | Lead model | Worker model | Builds |
|---|---|---|---|---|---|---|
| `epic-a-contract` | A · The contract | `epic/a-contract` | `../onto-a` | Opus 5.5 | Sonnet 5.5 | 0:00 to 0:25, then on call for contract changes |
| `epic-b-cli-store-server` | B · CLI, store and server | `epic/b-cli` | `../onto-b` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 |
| `epic-c-engine` | C · The engine | `epic/c-engine` | `../onto-c` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 |
| `epic-d-web-shell` | D · The web shell, including the lens switcher and fused legend | `epic/d-shell` | `../onto-d` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 |
| `epic-e-2d-graph` | E · The 2D graph view | `epic/e-graph` | `../onto-e` | Opus 5.5 | Sonnet 5.5 | 0:15 to 1:40 |
| `epic-f-3d-sky` | F · The 3D view (stretch) | `epic/f-sky` | `../onto-f` | Opus 5.5 | Sonnet 5.5 | 0:15 to 2:10 |
| `epic-g-fuse-rosetta` | G · Fuse and Rosetta (engine side) | `epic/g-fuse` | `../onto-g` | Opus 5.5 | Sonnet 5.5 | 0:15 to 2:20 (offline by 1:40; live check after integration) |
| `epic-h-ship` | H · Ship and demo | `epic/h-ship` | `../onto-h` | Opus 5.5 | Sonnet 5.5 | 0:25 to 2:50 (README and package check early; demo after integration) |

Every session reads and plans from 0:00; "Builds" is when it starts writing code (after Epic A's first drop lands, about 0:15).

**Why these models.** Every lead runs Opus 5.5 and every worker runs Sonnet 5.5. Leads coordinate and judge (planning, checking every body of work, landing), which is where the strongest model pays; Sonnet workers do the bounded building.

## The clock

| Time | What happens |
|---|---|
| 0:00 | All sessions start. Epic A builds. Everyone else reads their contract and plans their bodies of work. |
| about 0:15 | Epic A's first drop on `main`: schema, events, `fold`, fixtures, every placeholder. B, C, D, E, F and G merge `main` and build. |
| about 0:25 | Epic A's second drop: tokens, layout, view standard, dev harness. H starts. |
| 0:15 to 1:40 | B to G build in parallel and land whenever a body of work passes the full check. |
| as soon as B's CLI and C's engine are both on `main` (target 1:20, no later than 1:40) | **Integration:** B swaps the engine stub for `createEngine`; the train lead runs the demo topic end to end. |
| after integration | G runs its live checks and lands. H records the demo map. |
| 2:10 | The human decides whether Epic F (3D) stays. |
| 2:20 | Feature freeze: only fixes for `main` and Epic H land. |
| 2:50 | H says "Ready to publish"; the human publishes to npm (`HUMAN.md`). |

**Cut order if the clock slips:**
1. Epic F (3D) and its transition.
2. Node-id tab completion; name completion stays.
3. Rosetta.
4. Fuse.

Never cut the 2D graph view, live streaming, the node menu, Explain, save and load.

## Rules that hold everywhere

1. **Branches, not pull requests.** Each epic works on its own branch. The epic lead merges to `main` when a body of work is ready, after the full local check passes. There is no CI and there are no pull requests (`LEAD.md`, "Landing").
2. **`main` always runs.** `npm run check` must pass on `main` at every moment. It runs in well under a minute and needs no network and no API key.
3. **Stay inside your files.** Each contract lists what the epic owns, what it may touch, and what it must not touch. A change to someone else's files goes through their lead, by way of the human.
4. **The contract in Epic A is the only shared truth.** If two epics disagree about data, events or the view standard, Epic A's files win, and the S0 lead decides any change.
5. **No secrets in git.** The Anthropic API key lives in the OS keychain (the CLI asks for it on first use and stores it there) or in `ANTHROPIC_API_KEY`. Never in a file, a log, an event, or the repository.

## Changes since the design was locked

- **Leads land their own epics.** Each epic lead merges its own branch to `main`; nobody gathers pull requests at integration.
- **Lead and worker models.** Every lead is Opus 5.5 and every worker is Sonnet 5.5; the lead checks every body of work.
- **Epic A ships more up front, so no session waits on another:**
  - a dev harness, so the views can be built before the server and shell exist;
  - every npm dependency;
  - the browser import map.
- **The API key moved to the keychain.** `ontologizer` asks for the key the first time it needs one and keeps it in the OS keychain; `ANTHROPIC_API_KEY` still wins when set (Epic B: `src/cli/apikey.js`).
- **One session per epic, plus a train lead.** G and H have their own sessions and worktrees and build in the parallel window instead of waiting for 2:10 and 2:40. G's shell half moved into Epic D (it only reads data that already exists in the schema). Fuse and Rosetta live in their own engine files, which Epic A creates as placeholders and Epic C's `createEngine` attaches from the start, so G never edits another epic's file. Integration starts as soon as B and C have both landed.
- **A human epic** (`HUMAN.md`) holds everything that needs a person: accounts, keys, the npm publish, the go or no-go on 3D.
