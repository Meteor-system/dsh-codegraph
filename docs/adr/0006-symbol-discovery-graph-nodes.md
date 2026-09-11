# ADR-0006: Symbol discovery without a fourth mode; graph nodes and strict matching

**Date:** 2026-09-11
**Status:** Accepted

## Context

`codegraph_explore` can answer callers/impact/reachability only when the agent already knows a unique symbol. That is not enough for primary lookup: agents often start from a path or a short name. Adding a `symbols` mode or a second tool would reopen ADR-0002. Treating every named binding as a node, or falling back to substring/heuristic hits, is how `store` matched a test local and how a miss was reported as “ranked candidates” with an empty list.

## Decision

- **No fourth mode, no sibling tool.** Symbol discovery is what happens when `target` does not uniquely identify a graph node: return ranked `candidates` and do not walk. A path-shaped target lists discoverable nodes in that path. ADR-0002 stands.
- **Graph node** = module-level declaration (exported or not) or a method. Block-scoped locals are not nodes. Method candidates use a qualified name (`Owner.method`) copyable into the next `target`.
- **Strict matching:** case-insensitive full node name, `file:line` on a node, or path prefix. Never substring. A miss is empty `paths` and empty `candidates` plus a diagnostic, not `partial`. Heuristic text hits are not symbols (ADR-0004 still labels heuristic *edges* after a unique target).
- **Ranking:** non-test paths before `tests/`, `__tests__/`, `*.spec.*`, `*.test.*`, then path, then line. Tests stay in the graph.
- **Skill grain stays narrower:** `/codegraph` diff impact still caps at 10 top-level exports. Unexported declarations and methods are a follow-up explore, not a wider pass.

## Considered options

- Fourth mode / second tool — rejected (ADR-0002; agents already learn one contract).
- Path target runs the requested mode over every symbol in the file — rejected (blows the result budget; silent mix of walks).
- Substring or heuristic-as-candidate — rejected (false symbols).
- Export-only nodes — rejected (misses `executeExplore` / `hostTool` / methods).
- Every named binding — rejected (test locals become symbols).
- Align the skill onto graph nodes — rejected (keeps the pass small).

## Consequences

- Snapshot/index contents and matching rules are part of the evidence contract; a grain or matching change likely needs a schema rebuild.
- Empty-`candidates` while claiming ranked candidates is a bug against this ADR and ADR-0004, not a discovery feature.
