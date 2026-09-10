## Parent

#1

## What to build

`mode: reachability` proves whether and how X reaches Y (ordered paths; "no path" is a definitive, fast answer). `mode: impact` runs a bounded transitive closure over relations with `max_depth` (default 5, hard cap enforced), presenting direct and transitive impact as separate layers. Package-boundary awareness lands later (monorepo ticket); this ticket uses the whole graph.

## Acceptance criteria

- [ ] Reachability returns ordered paths when a path exists and an explicit empty/absent-path result with diagnostics when it does not.
- [ ] Impact default depth 5, adjustable; hard cap enforced (over-cap requests are clamped with a diagnostic).
- [ ] Direct vs transitive impact distinguishable in the response shape.
- [ ] Cycles in fixtures terminate with correct bounded results (no infinite traversal).
- [ ] Impact on a mid-chain symbol matches hand-verified fixture expectations.

## Blocked by

- Ticket 3 (#4, callers mode)
