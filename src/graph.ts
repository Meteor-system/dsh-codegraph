/**
 * The graph index: lazy build on first query (ADR-0003), snapshot-persisted,
 * answered through the codegraph_explore contract. Ticket 2 covers the TS
 * family (definitions + imports); later tickets layer callers/reach/impact
 * traversal, incremental refresh, and other languages on top.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { RelationEdge, RelationKind, Diagnostic } from './model.ts'
import { scanProject, DEFAULT_SCAN_LIMITS } from './scan.ts'
import { relationsForFile } from './extract-ts.ts'
import { loadSnapshot, saveSnapshot } from './store.ts'

export interface IndexMetadata {
  capabilities: Record<string, { stage: 'P1'; precision: string }>
  index: {
    status: 'built' | 'reused' | 'rebuilt'
    files: number
  }
}

export interface GraphQuery {
  mode: string
  target?: string
  relation?: RelationKind
  limit?: number
}

const RESULT_DEFAULT_LIMIT = 50

/**
 * Post-process call edges once every project definition is known:
 * a call whose callee matches a project-wide definition stays
 * `inferred` (name-matched across files, ADR-0004); one that matches
 * nothing is dynamic/unresolvable and drops to `heuristic`.
 */
function resolveCallConfidence(byFile: Record<string, RelationEdge[]>): void {
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

export interface GraphAnswer {
  paths: Array<{ edges: RelationEdge[] }>
  diagnostics: Diagnostic[]
  metadata: IndexMetadata
}

/** One project, one index (ADR-0003). */
export class ProjectGraph {
  private edges: RelationEdge[] = []
  private metadata: IndexMetadata

  constructor(private readonly projectRoot: string) {
    this.metadata = {
      capabilities: {
        typescript: { stage: 'P1', precision: 'syntax+inferred' },
        tsx: { stage: 'P1', precision: 'syntax+inferred' },
        javascript: { stage: 'P1', precision: 'syntax+inferred' },
        jsx: { stage: 'P1', precision: 'syntax+inferred' },
        python: { stage: 'P1', precision: 'syntax+inferred' },
        go: { stage: 'P1', precision: 'syntax+inferred' },
        rust: { stage: 'P1', precision: 'syntax+inferred' },
        java: { stage: 'P1', precision: 'syntax+inferred' },
      },
      index: { status: 'built', files: 0 },
    }
  }

  /** Build lazily on first use; reuse a valid snapshot afterwards. */
  ensureBuilt(): void {
    if (this.metadata.index.status !== 'built' || this.edges.length > 0) return
    const snap = loadSnapshot(this.projectRoot)
    if (snap !== undefined) {
      this.edges = Object.values(snap.byFile).flat()
      this.metadata.index.status = 'reused'
      this.metadata.index.files = Object.keys(snap.byFile).length
      return
    }
    this.rebuild()
  }

  /** Full rebuild: scan + extract + persist. Also the version-mismatch path. */
  rebuild(): void {
    const scan = scanProject(this.projectRoot, DEFAULT_SCAN_LIMITS)
    const fileSet = new Set(scan.files)
    const byFile: Record<string, RelationEdge[]> = {}
    for (const rel of scan.files) {
      const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
      if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue
      try {
        byFile[rel] = relationsForFile(join(this.projectRoot, rel), rel, fileSet)
      } catch {
        byFile[rel] = []
      }
    }
    resolveCallConfidence(byFile)
    this.edges = Object.values(byFile).flat()
    saveSnapshot(this.projectRoot, { schemaVersion: 1, byFile })
    this.metadata.index.status = 'rebuilt'
    this.metadata.index.files = scan.files.length
  }

  answer(query: GraphQuery): GraphAnswer {
    this.ensureBuilt()
    const limit = Math.min(query.limit ?? RESULT_DEFAULT_LIMIT, RESULT_DEFAULT_LIMIT)
    // Mode decides the default edge vocabulary (ADR-0002): callers asks
    // about call edges; without an explicit relation filter, definitions
    // of the target itself are included as anchor context.
    const wanted: RelationKind[] = query.relation
      ? [query.relation]
      : query.mode === 'callers'
        ? ['call', 'definition']
        : ['definition', 'import']

    let edges = this.edges.filter((e) => wanted.includes(e.kind))
    if (query.target !== undefined) {
      const needle = query.target.toLowerCase()
      const matching = edges.filter((e) => e.target.toLowerCase() === needle || e.target.toLowerCase().endsWith('/' + needle))
      if (matching.length === 0) {
        // No exact match: ranked candidates instead of a silent pick.
        const candidates = this.edges
          .filter((e) => e.kind === 'definition' && e.target.toLowerCase().includes(needle))
          .slice(0, limit)
        return {
          paths: candidates.map((e) => ({ edges: [e] })),
          diagnostics: [{ code: 'partial', message: 'no exact symbol match; returning ranked candidates' }],
          metadata: this.metadata,
        }
      }
      // Callers walk upstream: from the target's direct call edges, keep
      // following reverse call edges (who calls the caller) up to the
      // result budget, so multi-hop chains resolve (ticket 3 AC).
      // A hop's caller lives in `hop.source` (a file); the symbol it
      // defines and that the next hop calls is the file's basename.
      // The target's own definition edges stay as anchor context.
      if (query.mode === 'callers' && query.relation === undefined) {
        const callEdges = this.edges.filter((e) => e.kind === 'call')
        const upstream: RelationEdge[] = matching.filter((e) => e.kind === 'definition')
        const frontier = matching.filter((e) => e.kind === 'call')
        const seen = new Set(frontier.map((e) => `${e.source}|${e.target}|${e.location.line}`))
        for (const e of frontier) upstream.push(e)
        let guard = 0
        while (frontier.length > 0 && upstream.length < limit && guard++ < 64) {
          const hop = frontier.shift()!
          const callerFile = hop.source.split('/').pop() ?? hop.source
          const callerSymbol = callerFile.replace(/\.[^.]+$/, '')
          for (const next of callEdges) {
            const nt = next.target.toLowerCase()
            if (nt === callerSymbol.toLowerCase() || nt.endsWith('/' + callerSymbol.toLowerCase())) {
              const key = `${next.source}|${next.target}|${next.location.line}`
              if (!seen.has(key)) {
                seen.add(key)
                upstream.push(next)
                frontier.push(next)
              }
            }
          }
        }
        edges = upstream
      } else {
        edges = matching
      }
    }

    // One path per edge for ticket 2 (callers/reach compose paths later).
    const paths = edges.slice(0, limit).map((e) => ({ edges: [e] }))
    const diagnostics: Diagnostic[] = []
    if (edges.length > limit) {
      diagnostics.push({ code: 'truncated', message: `${edges.length - limit} more relations beyond limit` })
    }
    return { paths, diagnostics, metadata: this.metadata }
  }
}
