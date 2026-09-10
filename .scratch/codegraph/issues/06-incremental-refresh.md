## Parent

#1

## What to build

Incremental refresh per ADR-0003: before each tool call, detect file changes and run a single-flight incremental pass per project; queries execute against the resulting consistent snapshot. Concurrent queries never race or interleave index writes. When build/refresh exceeds the tool timeout, the call returns `indexing` status with progress and retry guidance — never a stale or mixed answer.

## Acceptance criteria

- [ ] Editing a fixture file then querying reflects the new code (new/changed edges appear) without a full rebuild (observable via metadata).
- [ ] Deleting a fixture file removes its nodes/edges from subsequent answers.
- [ ] Two concurrent queries during a refresh are serialized (single-flight); both receive snapshot-consistent answers.
- [ ] A simulated long refresh past the tool timeout returns `indexing` status with progress and retry info; a subsequent call after completion succeeds.
- [ ] No stale-while-revalidate: answers never mix pre- and post-change graph state.

## Blocked by

- Ticket 2 (#3, lazy index + snapshot store)
