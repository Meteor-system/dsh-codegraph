# ADR-0007: Unique short-name calls rewrite to `Owner.method`

**Date:** 2026-09-11
**Status:** Accepted

A short-name call that uniquely matches one method graph node is stored as that qualified name, so callers/impact of `Owner.method` see the same `target` as the definition. Same-file unique match is `exact`; unique across the project is `inferred`. Several matching owners keep the short name and `heuristic` — never fan-out. This is evidence-contract shape (ADR-0004), not a fourth mode and not a web graph. Snapshot identity of call edges changes; a schema bump rebuilds.
