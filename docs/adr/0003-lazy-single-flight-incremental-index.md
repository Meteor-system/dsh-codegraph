# ADR-0003: Lazy per-project index with single-flight incremental refresh

**Date:** 2026-09-10
**Status:** Accepted

## Context

Enabling the plugin must not scan the project immediately; queries must never mix two graph states; large monorepos must not stall an agent session. The index is derived, rebuildable data tied to file contents and paths.

## Decision

- **Storage:** the graph cache lives at `<project>/.dsh/codegraph/`, inside default ignore rules, schema-versioned; a version mismatch triggers a full rebuild. Enablement state is per project root; the bundle itself installs once per DSH profile.
- **Build trigger:** lazy — the first `codegraph_explore` call after enabling builds the graph; enabling alone does no work.
- **Refresh:** before each call, check file changes; run a **single-flight** incremental pass (one update at a time per project) and query the resulting **consistent snapshot**. No stale-while-revalidate; no filesystem watchers in v1.
- **Timeout behavior:** if a build/refresh exceeds the tool timeout, return `indexing` status with progress and retry info rather than a stale answer.
- **Scan scope:** respect `.gitignore` + default exclusions (dependencies, build output, caches, VCS dirs); index only supported-language source files; project include/exclude globs may override.
- **Budgets (defaults, per-project overridable):** skip files > 1 MB; stop scanning at 50,000 files; first-build timeout 120 s; every skip lands in diagnostics, never silent.

## Consequences

- Answers are always snapshot-consistent; worst case is a bounded wait, then an explicit retry.
- No background resource use between calls.
- Monorepos are one graph rooted at the project root, with package/module boundaries recorded inside it.
