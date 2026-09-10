# ADR-0004: Evidence contract — confidence labels, candidate disambiguation, bounded results

**Date:** 2026-09-10
**Status:** Accepted

## Context

The tool replaces many `Read`/`Grep` calls, so its answers must be verifiable without flooding the agent's context. Parsers cannot fully resolve dynamic dispatch, macros, overloads, or cross-language semantics; the tool must never dress a guess up as a proven relation.

## Decision

- **Confidence per edge:** every relation carries `exact` (parser-proven), `inferred` (import/export or qualified-name matching), or `heuristic` (text-level evidence, including optional supplemental search). Results can be filtered by confidence.
- **Candidate disambiguation:** ambiguous symbols (overloads, same-name functions, cross-package types) resolve to a ranked candidate list — qualified name, path, language, line — and the agent must disambiguate. The tool never silently picks.
- **Impact is bounded:** `impact` runs a transitive closure with `max_depth` default 5 (adjustable, hard cap enforced); direct and transitive impact are presented as separate layers.
- **Result budget:** default ≤ 50 relation paths per call (ranked by distance/confidence), `truncated: true` + total count when exceeded; `limit` adjustable to a hard cap of 200; snippets off by default, 1–3 locating lines each when enabled; lines > 10,000 characters truncated.
- **Diagnostics are first-class:** enumerated codes (`partial`, `unsupported_language`, `indexing`, `truncated`, file-skip reasons) accompany results; every result states the project's per-language capabilities. Partial results + diagnostics always beat failure or fabrication.

## Consequences

- Agents can trust, filter, or re-verify any edge by confidence; reading the underlying file remains the escalation path, not a necessity.
- Result size is bounded on both index (scan budgets) and query (path caps) sides.
- Text-search fallback evidence, when used, is always labeled `heuristic` so it can't be confused with graph proof.
