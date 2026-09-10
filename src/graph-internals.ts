/**
 * Graph internals shared between the full rebuild (graph.ts) and the
 * incremental refresh (refresh.ts). Kept free of node:path/fs imports
 * where possible so both call sites stay thin.
 */

import type { RelationEdge } from './model.ts'

/**
 * Post-process call edges once every project definition is known:
 * a call whose callee matches a project-wide definition stays
 * `inferred` (name-matched across files, ADR-0004); one that matches
 * nothing is dynamic/unresolvable and drops to `heuristic`.
 */
export function resolveCallConfidence(byFile: Record<string, RelationEdge[]>): void {
  const definedNames = new Set<string>()
  for (const edges of Object.values(byFile)) {
    for (const e of edges) {
      if (e.kind === 'definition') definedNames.add(e.target.toLowerCase())
    }
  }
  for (const edges of Object.values(byFile)) {
    for (const e of edges) {
      if (e.kind === 'call' && !definedNames.has(e.target.toLowerCase())) {
        e.confidence = 'heuristic'
      }
    }
  }
}
