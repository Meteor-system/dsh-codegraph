/**
 * Graph internals shared between the full rebuild (graph.ts) and the
 * incremental refresh (refresh.ts). Kept free of node:path/fs imports
 * where possible so both call sites stay thin.
 */

import type { RelationEdge } from './model.ts'

function shortNameOf(name: string): string {
  if (name.includes('/')) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : name
}

/**
 * Post-process call edges once every project definition is known.
 * Unqualified names keep extract-time exact/inferred. A short-name call
 * that uniquely matches `Owner.method` becomes `inferred` (ADR-0004
 * qualified-name matching); same-file unique owner is `exact`. Several
 * owners and no proof stay `heuristic`.
 */
export function resolveCallConfidence(byFile: Record<string, RelationEdge[]>): void {
  const defs: Array<{ full: string; short: string; file: string }> = []
  for (const edges of Object.values(byFile)) {
    for (const e of edges) {
      if (e.kind !== 'definition') continue
      const full = e.target.toLowerCase()
      defs.push({ full, short: shortNameOf(full), file: e.location.file.replace(/\\/g, '/') })
    }
  }

  for (const edges of Object.values(byFile)) {
    for (const e of edges) {
      if (e.kind !== 'call') continue
      const t = e.target.toLowerCase()
      const fullMatches = defs.filter((d) => d.full === t)
      if (fullMatches.length > 0) continue
      const methodMatches = defs.filter((d) => d.full !== t && d.short === t)
      if (methodMatches.length === 0) {
        e.confidence = 'heuristic'
        continue
      }
      const callFile = e.location.file.replace(/\\/g, '/')
      const inFile = methodMatches.filter((d) => d.file === callFile)
      if (inFile.length === 1) {
        e.confidence = 'exact'
        continue
      }
      if (methodMatches.length === 1) {
        e.confidence = 'inferred'
        continue
      }
      e.confidence = 'heuristic'
    }
  }
}
