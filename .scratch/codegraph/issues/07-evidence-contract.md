## Parent

#1

## What to build

The evidence contract per ADR-0004: every relation edge carries `confidence: exact | inferred | heuristic`; the `confidence` filter restricts output; ambiguous symbols (overloads, same-name functions, cross-package types) return ranked candidate lists — qualified name, path, language, line — never a silent pick; results are budgeted (default ≤ 50 relation paths ranked by distance/confidence, `truncated: true` + total count when exceeded, `limit` adjustable to a hard cap of 200, `include_snippets` opt-in at 1–3 locating lines, lines > 10,000 chars truncated in snippet output).

## Acceptance criteria

- [ ] Every edge in every mode carries a confidence label; fixtures produce all three labels (exact parser-proven, inferred cross-file, heuristic fallback).
- [ ] `confidence` filter narrows output accordingly (e.g. exact-only for precision-critical queries).
- [ ] Overload/same-name fixtures return ranked candidate lists; the tool never auto-selects.
- [ ] A fixture with > 50 paths returns 50 by default with `truncated: true` and total count; `limit` raises/lowers within the 200 hard cap; over-cap requests clamp with a diagnostic.
- [ ] `include_snippets: true` adds 1–3 locating lines per evidence; default output has no snippets.
- [ ] Long-line truncation observable in snippet output.

## Blocked by

- Ticket 3 (#4, callers mode)
