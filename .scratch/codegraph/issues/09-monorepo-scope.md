## Parent

#1

## What to build

Monorepo support within the single project-root graph: package/module boundaries recorded as first-class nodes/edges inside the one graph; the `scope` query parameter (path prefix or package prefix) filters results. A multi-package fixture demonstrates cross-package impact respecting package edges.

## Acceptance criteria

- [ ] A multi-package fixture builds one graph containing package boundary nodes; each symbol resolves to its package.
- [ ] `scope` by package prefix restricts results to that package.
- [ ] `scope` by path prefix restricts results to that subtree.
- [ ] Cross-package edges (e.g. package A imports package B) appear and are filterable by `relation: import`.
- [ ] Impact on a shared symbol crosses package boundaries correctly within the single graph.

## Blocked by

- Ticket 3 (#4, callers mode)
