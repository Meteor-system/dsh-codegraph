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
    this.edges = Object.values(byFile).flat()
    saveSnapshot(this.projectRoot, { schemaVersion: 1, byFile })
    this.metadata.index.status = 'rebuilt'
    this.metadata.index.files = scan.files.length
  }

  answer(query: GraphQuery): GraphAnswer {
    this.ensureBuilt()
    const limit = Math.min(query.limit ?? RESULT_DEFAULT_LIMIT, RESULT_DEFAULT_LIMIT)
    const wanted: RelationKind[] = query.relation ? [query.relation] : ['definition', 'import']

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
      edges = matching
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
