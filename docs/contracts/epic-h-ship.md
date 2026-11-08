# Epic H · Ship and demo

| Session | Branch | Worktree | Lead | Workers | Window |
|---|---|---|---|---|---|
| `epic-h-ship` | `epic/h-ship` | `../onto-h` | Opus 5.5 | Sonnet 5.5 | 0:25 to 2:50 |

Read `LEAD.md` first. Start early, in this order:
- **from 0:25:** `test/h/` (the checks below, against Epic A's `package.json`) and the README skeleton from the contracts;
- **once Epic B's CLI is on `main`:** fill the command list from `ontologizer --help`;
- **right after integration:** record the demo map and the screenshot;
- **2:20 (freeze) to 2:50:** final package audit, then "Ready to publish".

## Goal

Ontologizer ready to publish:
- a README that gets a stranger to a live map in two commands;
- a package that contains exactly what it needs and nothing private;
- a recorded demo map that replays with no network.

**The npm publish itself is the human's job** (`HUMAN.md`), because it needs the human's npm login and one-time password. This epic gets everything ready for it.

## You own

- `README.md`
- `test/h/`
- the demo map: `fixtures/demo.events.jsonl`, recorded from a real run

**May touch:** `package.json` (the `files`, `description`, `keywords`, `repository`, `homepage` and `version` fields only).
**Must not touch:** any code. If you find a bug, report it to the human with the failing output.

## Interface

```bash
npm i -g ontologizer
ontologizer new                                    # asks for your Anthropic API key once, stores it in the
                                                   # system keychain; the first two commands end on a live map
ontologizer load demo --replay --speed 1           # the offline demo
```

The README, in this order, kept short:
1. One sentence on what it is, and one screenshot or GIF of the 2D graph mid-build (`docs/screenshot.png`).
2. Install and first run.
3. Every command, from `ontologizer --help`.
4. How it works, in five lines: the context check, streaming waves, the event log, views, fuse and Rosetta.
5. Requirements: Node 22+, an Anthropic API key (asked for on first run and kept in your system keychain; `ANTHROPIC_API_KEY` overrides it; `ontologizer key set|clear` to change it). Notes on cost and privacy:
   - each map makes a dozen or so model calls;
   - topics and maps are sent to the Anthropic API;
   - maps are stored in `~/.ontologizer/`.
6. License: MIT (see LICENSE; name and logo: TRADEMARKS.md).

## Work

- **W1: README draft from `--help` output and the contracts.** The lead edits it.
- **W2: package audit.**
  - Run `npm pack --dry-run` and list every file.
  - Confirm that nothing from `.claude/`, `test/` or `docs/contracts/` ships unless intended, and that there is no `.env` file, no key and no absolute path.
  - Fix the `files` field.
- **The lead:**
  1. Record the demo map. Run `ontologizer new` live on the demo topic and save it as `demo`.
  2. Copy its `events.jsonl` to `fixtures/demo.events.jsonl`, so `load demo --replay` also works from a fresh install. Epic B's `load` falls back to `fixtures/<name>.events.jsonl` when the store has no such map.
  3. Take the screenshot.

## Checks: `npm run check:h`

| Check | Planted fault it must catch |
|---|---|
| `npm pack --dry-run --json` includes `src/cli/index.js`, `web/index.html`, `web/shared/importmap.json` and `fixtures/demo.events.jsonl`. | A `files` field that leaves out `web/`. |
| The packed file list has no `.env`, no file under `test/`, and no file whose text matches `sk-ant-`. | A planted `test/.env` containing `sk-ant-test`. |
| `src/cli/index.js` starts with `#!/usr/bin/env node`. | The shebang removed. |

## Try it

```bash
npm pack                                  # produces ontologizer-0.1.0.tgz
npm i -g ./ontologizer-0.1.0.tgz          # install the tarball, exactly as npm users will get it
ontologizer doctor && ontologizer load demo --replay
```
Then turn the network off and run `ontologizer load demo --replay` again.

## Not in this epic

- No npm publish (the human does it).
- No hosted web version.
- No telemetry.

## Hand-offs

- Tell the human: "Ready to publish". Include the `npm pack --dry-run` file count, the tarball size, and the commit on `main` to publish from.
