## Parent

#1

## What to build

`mode: callers` answers "who calls X" from the graph: ordered relation paths where each edge carries kind, source/target symbol identity, and file/line/col. The `relation` filter restricts which edge kinds are returned (definition/call/import/inherit/type-ref). TypeScript family fixture coverage.

## Acceptance criteria

- [ ] Callers query on a fixture returns ordered edges ranked by distance, each with kind + locations.
- [ ] `relation` filter narrows output to the requested kinds.
- [ ] Direct and multi-hop caller chains both resolve on fixtures.
- [ ] Calls the plugin cannot resolve semantically surface as `inferred`/`heuristic` edges (labels fully specified in the evidence-contract ticket; this ticket only requires the field exists).

## Blocked by

- Ticket 2 (#3)
