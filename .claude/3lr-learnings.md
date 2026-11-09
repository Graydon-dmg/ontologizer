# 3LR learnings (Ontologizer)

Project-specific patterns for reviewers to also check. Append; never remove.

- **Fuse writes into a draft that has no job of its own.** Its job events go on the source map. Anything that asks "is this map busy?" (save, wait, idle eviction) must also check in-progress fuse drafts.
- **Async handler caches need a "still current?" check after every await.** A save or eviction can drop the key mid-build; never hand back a handler that is no longer in the cache.
- **Open mode (no tokens) trusts loopback plus a proxy-header heuristic.** A raw tunnel or port forward adds no headers. Treat open mode as this-machine-only, and make every HTML page refuse framing so a hostile site can't drive clicks that spend the user's API key.
- **Tenant-scoped admin is not server admin.** Any route that reads across tenants needs an explicit default-tenant admin check.
