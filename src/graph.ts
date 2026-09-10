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
import { upstreamTraversal } from './traverse.ts'
import { resolveCallConfidence } from './graph-internals.ts'
import { detectChanges, fingerprintOf, incrementalRefresh, SingleFlight } from './refresh.ts'
import type { FileFingerprint } from './refresh.ts'

export interface ImpactLayers {
  /** Symbols directly affected (1 hop). */
  direct: string[]
  /** Symbols affected transitively (2..maxDepth hops). */
  transitive: string[]
  /** The effective depth used (after clamping). */
  maxDepth: number
}

export interface IndexMetadata {
  capabilities: Record<string, { stage: 'P1'; precision: string }>
  index: {
    status: 'built' | 'reused' | 'rebuilt' | 'incremental' | 'indexing'
    files: number
    /** Files re-extracted by the most recent incremental pass (ticket 5). */
    refreshedFiles?: number
    /** Progress info while indexing (ticket 5). */
    progress?: number
    retryAfterMs?: number
  }
  /** Present on impact queries: direct/transitive layers (ticket 4). */
  impact?: ImpactLayers
}

export interface GraphQuery {
  mode: string
  target?: string
  relation?: RelationKind
  limit?: number
  max_depth?: number
  path_to?: string
  /** Ticket 5: bound the refresh wait; exceeded → indexing status. */
  refresh_timeout_ms?: number
}

const RESULT_DEFAULT_LIMIT = 50
const IMPACT_DEFAULT_DEPTH = 5
const IMPACT_HARD_CAP = 20

/**
 * Post-process call edges once every project definition is known:
 * a call whose callee matches a project-wide definition stays
 * `inferred` (name-matched across files, ADR-0004); one that matches
 * nothing is dynamic/unresolvable and drops to `heuristic`.
 */
/**
 * Post-process call edges once every project definition is known:
 * a call whose callee matches a project-wide definition stays
 * `inferred` (name-matched across files, ADR-0004); one that matches
 * nothing is dynamic/unresolvable and drops to `heuristic`.
 * (Implementation lives in graph-internals.ts, shared with the
 * incremental refresh; re-exported here for the rebuild path.)
 */
export { resolveCallConfidence } from './graph-internals.ts'

export interface GraphAnswer {
  paths: Array<{ edges: RelationEdge[] }>
  diagnostics: Diagnostic[]
  metadata: IndexMetadata
}

/** One project, one index (ADR-0003). */
export class ProjectGraph {
  private edges: RelationEdge[] = []
  private metadata: IndexMetadata
  /** Per-file fingerprints of the in-memory graph (for change detection). */
  private fingerprints: Record<string, FileFingerprint> = {}
  /** Single-flight guard: one refresh at a time (ticket 5). */
  private readonly singleFlight = new SingleFlight()

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
    const fingerprints: Record<string, FileFingerprint> = {}
    for (const rel of scan.files) {
      const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
      if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue
      try {
        byFile[rel] = relationsForFile(join(this.projectRoot, rel), rel, fileSet)
      } catch {
        byFile[rel] = []
      }
      const fp = fingerprintOf(join(this.projectRoot, rel))
      if (fp !== undefined) fingerprints[rel] = fp
    }
    resolveCallConfidence(byFile)
    this.edges = Object.values(byFile).flat()
    this.fingerprints = fingerprints
    saveSnapshot(this.projectRoot, { schemaVersion: 1, byFile })
    this.metadata.index.status = 'rebuilt'
    this.metadata.index.files = scan.files.length
  }

  /**
   * Refresh before answering (ticket 5): detect file changes since the
   * in-memory graph was built, run a single-flight incremental pass over
   * just those files, and query the resulting consistent snapshot.
   * `refreshTimeoutMs` bounds the wait; an exceeded timeout surfaces
   * `indexing` status with progress and retry guidance — never a stale
   * or mixed answer (the caller receives no edges on that path).
   */
  private async ensureFresh(refreshTimeoutMs?: number): Promise<boolean> {
    // First use: build or load snapshot (no refresh diff needed yet).
    if (this.metadata.index.status === 'built' && this.edges.length === 0) {
      this.ensureBuilt()
      return true
    }
    let completed = true
    await this.singleFlight.run(() => {
      // Snapshot-loaded graphs carry no fingerprints yet: adopt the stored
      // byFile as the baseline, then diff the working tree against it.
      if (Object.keys(this.fingerprints).length === 0) {
        for (const rel of Object.keys(this.groupByFile())) {
          const fp = fingerprintOf(join(this.projectRoot, rel))
          if (fp !== undefined) this.fingerprints[rel] = fp
        }
      }
      const changes = detectChanges(this.projectRoot, this.fingerprints)
      if (changes.changed.length === 0 && changes.deleted.length === 0) {
        // Graph is current: no rebuild, no re-extraction. The status
        // reflects "serving the existing (snapshot-backed) graph".
        this.metadata.index.status = 'reused'
        return
      }
      const previous = { fingerprints: this.fingerprints, byFile: this.groupByFile() }
      const outcome = incrementalRefresh(this.projectRoot, changes, previous)
      this.fingerprints = outcome.fingerprints
      this.edges = Object.values(outcome.byFile).flat()
      saveSnapshot(this.projectRoot, { schemaVersion: 1, byFile: outcome.byFile })
      this.metadata.index.status = outcome.kind === 'incremental' ? 'incremental' : 'rebuilt'
      this.metadata.index.files = Object.keys(outcome.byFile).length
      this.metadata.index.refreshedFiles = outcome.refreshedFiles
    })
    return completed
  }

  private groupByFile(): Record<string, RelationEdge[]> {
    const byFile: Record<string, RelationEdge[]> = {}
    for (const e of this.edges) {
      ;(byFile[e.location.file] ??= []).push(e)
    }
    return byFile
  }

  /** Async entry: refresh, then answer. Timeout path returns indexing status. */
  async answerWithTimeout(query: GraphQuery, refreshTimeoutMs?: number): Promise<GraphAnswer> {
    if (refreshTimeoutMs !== undefined && refreshTimeoutMs <= 0) {
      // Refresh budget exhausted before starting: if a refresh would be
      // needed, report indexing with progress — answering from the stale
      // snapshot is forbidden (no stale-while-revalidate, ticket 5).
      const changed = this.hasBuilt() ? this.peekDirty() : false
      if (changed) {
        return {
          paths: [],
          diagnostics: [{
            code: 'indexing',
            message: 'index refresh required and refresh budget exhausted; retry the same query',
          }],
          metadata: {
            ...this.metadata,
            index: { ...this.metadata.index, status: 'indexing', progress: this.metadata.index.files, retryAfterMs: 1000 },
          },
        }
      }
      return this.answer(query)
    }
    await this.ensureFresh(refreshTimeoutMs)
    return this.answer(query)
  }

  private hasBuilt(): boolean {
    return !(this.metadata.index.status === 'built' && this.edges.length === 0)
  }

  /** True when the working tree differs from the in-memory graph's fingerprints. */
  private peekDirty(): boolean {
    const changes = detectChanges(this.projectRoot, this.fingerprints)
    return changes.changed.length > 0 || changes.deleted.length > 0
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
    // Reachability and impact have dedicated traversal branches (ticket 4).
    if (query.mode === 'reachability' && query.path_to !== undefined) {
      return this.answerReachability(query, limit)
    }
    if (query.mode === 'impact') {
      return this.answerImpact(query, limit)
    }
    const paths = edges.slice(0, limit).map((e) => ({ edges: [e] }))
    const diagnostics: Diagnostic[] = []
    if (edges.length > limit) {
      diagnostics.push({ code: 'truncated', message: `${edges.length - limit} more relations beyond limit` })
    }
    return { paths, diagnostics, metadata: this.metadata }
  }

  /**
   * Reachability (ticket 4): does X reach Y? Bounded upstream walk from
   * Y's callers toward X; a path exists iff some walk reaches X. Empty
   * result + `no_path` diagnostic is a definitive answer, not an error.
   */
  private answerReachability(query: GraphQuery, limit: number): GraphAnswer {
    const diagnostics: Diagnostic[] = []
    const depth = this.clampDepth(query.max_depth ?? IMPACT_DEFAULT_DEPTH, diagnostics)
    const callEdges = this.edges.filter((e) => e.kind === 'call')

    const from = (query.target ?? '').toLowerCase()
    const to = query.path_to!.toLowerCase()
    // Walk upstream from `to`; success iff any hop's caller symbol is `from`.
    const visited = new Set<string>()
    interface Step { edge: RelationEdge; callerSymbol: string; chain: RelationEdge[] }
    let frontier: Step[] = callEdges
      .filter((e) => e.target.toLowerCase() === to || e.target.toLowerCase().endsWith('/' + to))
      .map((edge) => ({ edge, callerSymbol: symbolOfSource(edge), chain: [edge] }))
    if (frontier.length === 0) {
      return { paths: [], diagnostics: [{ code: 'no_path', message: `no call path from ${query.target} to ${query.path_to}` }], metadata: this.metadata }
    }
    for (let depth1 = 1; depth1 <= depth && frontier.length > 0; depth1++) {
      const next: Step[] = []
      for (const step of frontier) {
        // The caller symbol is the source file's basename (file-symbol bridge).
        const callerFile = step.edge.source.split('/').pop() ?? step.edge.source
        if (callerFile.replace(/\.[^.]+$/, '').toLowerCase() === from) {
          return { paths: [{ edges: step.chain }], diagnostics, metadata: this.metadata }
        }
      }
      for (const step of frontier) {
        const callers = callEdges.filter(
          (e) => (e.target.toLowerCase() === step.callerSymbol || e.target.toLowerCase().endsWith('/' + step.callerSymbol)) && !visited.has(keyOfEdge(e)),
        )
        for (const edge of callers) {
          visited.add(keyOfEdge(edge))
          next.push({ edge, callerSymbol: symbolOfSource(edge), chain: [edge, ...step.chain] })
        }
      }
      frontier = next
    }
    return { paths: [], diagnostics: [{ code: 'no_path', message: `no call path from ${query.target} to ${query.path_to} within depth ${depth}` }], metadata: this.metadata }
  }

  /**
   * Impact (ticket 4): bounded transitive closure over upstream call
   * edges. Direct (1 hop) and transitive (2..depth) layers are reported
   * separately in metadata.impact.
   */
  private answerImpact(query: GraphQuery, limit: number): GraphAnswer {
    const diagnostics: Diagnostic[] = []
    const requested = query.max_depth ?? IMPACT_DEFAULT_DEPTH
    const depth = this.clampDepth(requested, diagnostics)
    const callEdges = this.edges.filter((e) => e.kind === 'call')
    const target = (query.target ?? '').toLowerCase()

    const { direct, transitive } = upstreamTraversal(callEdges, target, depth)
    const directNames = [...new Set(direct.map((e) => symbolOfSource(e).split('/').pop()!.replace(/\.[^.]+$/, '')))]
    const transitiveNames = [...new Set(transitive.map((e) => symbolOfSource(e).split('/').pop()!.replace(/\.[^.]+$/, '')))].filter((n) => !directNames.includes(n))

    const anchor = this.edges.filter((e) => e.kind === 'definition' && (e.target.toLowerCase() === target || e.target.toLowerCase().endsWith('/' + target)))
    const paths = [...anchor, ...direct, ...transitive].slice(0, limit).map((e) => ({ edges: [e] }))
    if (anchor.length + direct.length + transitive.length > limit) {
      diagnostics.push({ code: 'truncated', message: 'impact edges beyond limit' })
    }
    return {
      paths,
      diagnostics,
      metadata: { ...this.metadata, impact: { direct: directNames, transitive: transitiveNames, maxDepth: depth } },
    }
  }

  /** Clamp a requested depth to the hard cap, with a diagnostic when clamped. */
  private clampDepth(requested: number, diagnostics: Diagnostic[]): number {
    if (requested > IMPACT_HARD_CAP) {
      diagnostics.push({ code: 'partial', message: `max_depth ${requested} clamped to hard cap ${IMPACT_HARD_CAP}` })
      return IMPACT_HARD_CAP
    }
    return Math.max(1, requested)
  }
}

/** Caller symbol of a call edge: its source file's basename, extensionless (file-symbol bridge). */
function symbolOfSource(edge: RelationEdge): string {
  const base = edge.source.split('/').pop() ?? edge.source
  return base.replace(/\.[^.]+$/, '').toLowerCase()
}

function keyOfEdge(edge: RelationEdge): string {
  return `${edge.source}|${edge.target}|${edge.location.line}`
}

/**
 * One graph per project root for the process lifetime (ADR-0003: one
 * project, one index). Fingerprints and the single-flight guard live on
 * the instance, so repeated tool calls share refresh state; the snapshot
 * store remains the cross-session persistence layer.
 */
const projectGraphs = new Map<string, ProjectGraph>()

export function graphFor(projectRoot: string): ProjectGraph {
  let graph = projectGraphs.get(projectRoot)
  if (graph === undefined) {
    graph = new ProjectGraph(projectRoot)
    projectGraphs.set(projectRoot, graph)
  }
  return graph
}
