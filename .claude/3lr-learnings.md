# 3LR learnings (Ontologizer)

Project-specific patterns for reviewers to also check. Append; never remove.

- **Fuse writes into a draft that has no job of its own.** Its job events go on the source map. Anything that asks "is this map busy?" (save, wait, idle eviction) must also check in-progress fuse drafts.
- **Async handler caches need a "still current?" check after every await.** A save or eviction can drop the key mid-build; never hand back a handler that is no longer in the cache.
- **Open mode (no tokens) trusts loopback plus a proxy-header heuristic.** A raw tunnel or port forward adds no headers. Treat open mode as this-machine-only, and make every HTML page refuse framing so a hostile site can't drive clicks that spend the user's API key.
- **Tenant-scoped admin is not server admin.** Any route that reads across tenants needs an explicit default-tenant admin check.
- **Escaping must be idempotent when a value is cleaned twice** (once up front, again at output). A backslash escape run twice turns `\<` into `\\<`, which un-escapes it in markdown. Collapse any backslash run before the character to one.
- **Markdown handed to agents: neutralise `<` AND `[`, not just inline links.** Newline-flattening stops block syntax, but a one-line `[x]: javascript:...` still defines a link reference that `[x]` elsewhere uses, and `![x]` loads an image. URLs also need `( ) [ ] < >` percent-encoded.
- **Release pipelines with a build step:** build in its own job that runs only the build tool, hash the outputs, and have publish ship exactly those hashed files. The test job runs every dependency and must not be the source of published bytes.

## 2026-11-15 (1.9.0)
- **Fold lookups keyed by event data must be own-key** (`entry()` / `Object.hasOwn`), never `obj[key]`. A `lensId` or node id of `constructor` reaches a built-in, and since the event is already on disk the map can't open.
- **`store.read()` is live since 1.9.0 (folds in place).** Tests and handlers must copy any value they compare after a write.
- **Log jobs left queued/running by a dead process must not block new work.** Check that the job is live in this engine (`activeJobIds()`), not just its state in the log.
