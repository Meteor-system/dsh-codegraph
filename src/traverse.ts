/**
 * Bounded upstream graph traversal (ticket 4): impact closure layers.
 * All traversals are budget-bounded and cycle-safe; "who reaches whom"
 * is answered over call edges plus the file-symbol bridge (a hop's
 * caller symbol is its source file's basename).
 */

import type { RelationEdge } from './model.ts'

/** The caller symbol of a call edge: its source file's basename, extensionless. */
export function callerSymbolOf(edge: RelationEdge): string {
  const base = edge.source.split('/').pop() ?? edge.source
  return base.replace(/\.[^.]+$/, '').toLowerCase()
}

interface UpstreamStep {
  edge: RelationEdge
  /** Symbol this step's caller defines (the next hop matches against it). */
  callerSymbol: string
}

/**
 * Walk upstream from edges that target `fromSymbol`, following reverse
 * call edges up to maxDepth hops. Depth-1 edges are direct; deeper edges
 * are transitive. Cycles are broken by visited (source,target,line) keys.
 */
export function upstreamTraversal(
  callEdges: RelationEdge[],
  fromSymbol: string,
  maxDepth: number,
): { direct: RelationEdge[]; transitive: RelationEdge[] } {
  const direct: RelationEdge[] = []
  const transitive: RelationEdge[] = []
  const visited = new Set<string>()
  const target = fromSymbol.toLowerCase()

  let current: UpstreamStep[] = callEdges
    .filter((e) => e.target.toLowerCase() === target || e.target.toLowerCase().endsWith('/' + target))
    .map((edge) => ({ edge, callerSymbol: callerSymbolOf(edge) }))

  for (const step of current) {
    direct.push(step.edge)
    visited.add(keyOf(step.edge))
  }

  for (let depth = 2; depth <= maxDepth && current.length > 0; depth++) {
    const next: UpstreamStep[] = []
    for (const step of current) {
      const callers = callEdges.filter(
        (e) => (e.target.toLowerCase() === step.callerSymbol || e.target.toLowerCase().endsWith('/' + step.callerSymbol)) && !visited.has(keyOf(e)),
      )
      for (const edge of callers) {
        visited.add(keyOf(edge))
        transitive.push(edge)
        next.push({ edge, callerSymbol: callerSymbolOf(edge) })
      }
    }
    current = next
  }

  return { direct, transitive }
}

function keyOf(edge: RelationEdge): string {
  return `${edge.source}|${edge.target}|${edge.location.line}`
}
