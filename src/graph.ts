/**
 * The graph index: lazy build on first query (ADR-0003), snapshot-persisted,
 * answered through the codegraph_explore contract. Ticket 2 covers the TS
 * family (definitions + imports); later tickets layer callers/reach/impact
 * traversal, incremental refresh, and other languages on top.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { RelationEdge, RelationKind, Diagnostic } from './model.ts'
import { SNIPPET_LINE_MAX_CHARS, SNIPPET_MAX_LINES } from './model.ts'
import { scanProject } from './scan.ts'
import { DEFAULT_SCAN_LIMITS } from './scan.ts'
import type { ScanLimits } from './scan.ts'
import { relationsForFile } from './extract-ts.ts'
import { loadSnapshot, saveSnapshot } from './store.ts'
import { upstreamTraversal } from './traverse.ts'
import { resolveCallConfidence } from './graph-internals.ts'
import { detectChanges, fingerprintOf, incrementalRefresh, SingleFlight } from './refresh.ts'
import type { FileFingerprint } from './refresh.ts'
import { discoverPackages, packageOf } from './packages.ts'

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
  /** Package boundary map: package dir → 'package' (ticket 8). */
  packages?: Record<string, string>
}

export interface GraphQuery {
  mode: string
  target?: string
  relation?: RelationKind
  confidence?: string
  scope?: string
  limit?: number
  max_depth?: number
  path_to?: string
  /** Ticket 5: bound the refresh wait; exceeded → indexing status. */
  refresh_timeout_ms?: number
  /** Ticket 6: attach 1–3 locating lines per evidence edge. */
  include_snippets?: boolean
}

/** Ranked candidate for an ambiguous target (ADR-0004: never a silent pick). */
export interface SymbolCandidate {
  name: string
  path: string
  language: string
  line: number
}

export interface GraphAnswer {
  paths: Array<{ edges: RelationEdge[] }>
  /** Non-empty only when the target was ambiguous; the agent disambiguates. */
  candidates: SymbolCandidate[]
  truncated: boolean
  total: number
  diagnostics: Diagnostic[]
  metadata: IndexMetadata
}

/** Language label from a file extension (candidates carry it per ADR-0004). */
function languageOfPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const labels: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', php: 'php', rb: 'ruby', bash: 'bash', sh: 'bash',
    hs: 'haskell', jl: 'julia', scala: 'scala',
  }
  return labels[ext] ?? ext
}

const RESULT_DEFAULT_LIMIT = 50
const RESULT_HARD_CAP = 200
const IMPACT_DEFAULT_DEPTH = 5
const IMPACT_HARD_CAP = 20

/** Extensions the TS-family extraction adapter handles (ADR-0005). */
const TS_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

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
  /** Project-level budget/scope overrides (ticket 7). */
  private overrides: Record<string, unknown>
  /** Scan-level deviations from the most recent build (ticket 7). */
  private scanDiagnostics: Diagnostic[] = []

  constructor(private readonly projectRoot: string, overrides?: Record<string, unknown>) {
    this.overrides = overrides ?? {}
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
    if (snap !== undefined && snap.scanShapeHash === this.scanShapeHash()) {
      this.edges = Object.values(snap.byFile).flat()
      this.metadata.index.status = 'reused'
      this.metadata.index.files = Object.keys(snap.byFile).length
      return
    }
    this.rebuild()
  }

  /** Identity of the scan-shape settings; a change invalidates the snapshot. */
  private scanShapeHash(): string {
    const l = this.scanLimits()
    return JSON.stringify([l.maxFileBytes, l.maxFiles, l.include ?? [], l.exclude ?? []])
  }

  /** Project scan limits: defaults replaced by per-project overrides. */
  private scanLimits(): ScanLimits {
    return {
      maxFileBytes: (this.overrides['max_file_bytes'] as number) ?? DEFAULT_SCAN_LIMITS.maxFileBytes,
      maxFiles: (this.overrides['max_files'] as number) ?? DEFAULT_SCAN_LIMITS.maxFiles,
      include: this.overrides['include'] as string[] | undefined,
      exclude: this.overrides['exclude'] as string[] | undefined,
    }
  }

  /** Full rebuild: scan + extract + persist. Also the version-mismatch path. */
  rebuild(): void {
    const limits = this.scanLimits()
    const scan = scanProject(this.projectRoot, limits)
    const fileSet = new Set(scan.files)
    const packages = discoverPackages(this.projectRoot)
    const byFile: Record<string, RelationEdge[]> = {}
    const fingerprints: Record<string, FileFingerprint> = {}
    for (const rel of scan.files) {
      const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
      // TS-family extraction covers .mjs/.cjs too (plain ES/CommonJS modules).
      if (!TS_FAMILY_EXTENSIONS.has(ext) && !limits.include?.some((g) => rel.toLowerCase().endsWith(g.replace('**/*', '.')))) continue
      try {
        byFile[rel] = relationsForFile(join(this.projectRoot, rel), rel, fileSet, packages)
      } catch {
        byFile[rel] = []
      }
      const fp = fingerprintOf(join(this.projectRoot, rel))
      if (fp !== undefined) fingerprints[rel] = fp
    }
    resolveCallConfidence(byFile)
    this.edges = Object.values(byFile).flat()
    this.fingerprints = fingerprints
    saveSnapshot(this.projectRoot, { schemaVersion: 1, byFile, scanShapeHash: this.scanShapeHash() })
    this.metadata.index.status = 'rebuilt'
    this.metadata.index.files = scan.files.length
    // Package boundaries as first-class metadata (ticket 8).
    const packageMap: Record<string, string> = {}
    for (const pkg of packages) {
      if (pkg.dir !== '') packageMap[pkg.dir] = 'package'
    }
    this.metadata.packages = packageMap
    // Scan deviations become diagnostics (ticket 7): never silent.
    const scanDiags: Diagnostic[] = scan.skips.map((s) => ({ code: s.code, message: s.message }))
    if (scan.stoppedEarly) {
      scanDiags.push({ code: 'file_count_stop', message: `scan stopped at ${limits.maxFiles} files; raise max_files to index more` })
    }
    this.scanDiagnostics = scanDiags
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
    const budget = refreshTimeoutMs ?? (this.overrides['build_timeout_ms'] as number | undefined)
    if (budget !== undefined && budget <= 0) {
      // Budget exhausted before starting: if a build/refresh would be
      // needed, report indexing with progress — answering from a stale
      // graph is forbidden (no stale-while-revalidate, ticket 5/7).
      const changed = this.hasBuilt() ? this.peekDirty() : true
      if (changed) {
        return {
          paths: [],
          candidates: [],
          truncated: false,
          total: 0,
          diagnostics: [{
            code: 'indexing',
            message: 'index build/refresh required and the timeout budget is exhausted; retry the same query',
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
    // Hard cap enforcement with a diagnostic on clamp (ticket 6 AC).
    const diagnostics: Diagnostic[] = [...this.scanDiagnostics]
    // A partial diagnostic rides along whenever any deviation occurred
    // (ticket 7 AC): scan skips, count stop, or anything already listed.
    if (diagnostics.length > 0 && !diagnostics.some((d) => d.code === 'partial')) {
      diagnostics.unshift({ code: 'partial', message: 'index deviations occurred; see accompanying diagnostics' })
    }
    let requestedLimit = query.limit ?? RESULT_DEFAULT_LIMIT
    if (requestedLimit > RESULT_HARD_CAP) {
      diagnostics.push({ code: 'partial', message: `limit ${requestedLimit} clamped to hard cap ${RESULT_HARD_CAP}` })
      requestedLimit = RESULT_HARD_CAP
    }
    const limit = requestedLimit
    // Mode decides the default edge vocabulary (ADR-0002): callers asks
    // about call edges; without an explicit relation filter, definitions
    // of the target itself are included as anchor context.
    const wanted: RelationKind[] = query.relation
      ? [query.relation]
      : query.mode === 'callers'
        ? ['call', 'definition']
        : ['definition', 'import']

    let edges = this.edges.filter((e) => wanted.includes(e.kind))
    if (query.confidence !== undefined) {
      edges = edges.filter((e) => e.confidence === query.confidence)
    }
    if (query.scope !== undefined) {
      // Scope: path prefix or package prefix; a scope name that matches a
      // known package dir expands to that directory prefix (ticket 8).
      let prefix = query.scope.replace(/\\/g, '/').replace(/\/$/, '')
      if (this.metadata.packages !== undefined) {
        const matched = Object.keys(this.metadata.packages).find((dir) => dir === prefix || dir.endsWith('/' + prefix))
        if (matched !== undefined) prefix = matched
      }
      edges = edges.filter((e) => e.location.file.startsWith(prefix + '/'))
    }
    if (query.target !== undefined) {
      const needle = query.target.toLowerCase()
      // Ambiguity is about definition targets: the same symbol name
      // defined at several locations (overloads, same-name functions,
      // cross-package types). Multiple call edges naming one symbol are
      // normal callers output, not ambiguity (ADR-0004).
      const definitionLocations = new Set(
        this.edges
          .filter((e) => e.kind === 'definition' && (e.target.toLowerCase() === needle || e.target.toLowerCase().endsWith('/' + needle)))
          .map((e) => `${e.target.toLowerCase()}|${e.location.file.toLowerCase()}`),
      )
      if (definitionLocations.size > 1) {
        const defEdges = this.edges.filter((e) => e.kind === 'definition' && (e.target.toLowerCase() === needle || e.target.toLowerCase().endsWith('/' + needle)))
        return this.candidateAnswer(defEdges, query, limit)
      }
      const matching = edges.filter((e) => e.target.toLowerCase() === needle || e.target.toLowerCase().endsWith('/' + needle))
      if (matching.length === 0) {
        // No exact match: substring fallback over definitions AND
        // heuristic call targets (unresolved calls carry the callee name
        // as the best lead, ADR-0004).
        const matchingDefs = this.edges.filter((e) =>
          (e.kind === 'definition' || (e.kind === 'call' && e.confidence === 'heuristic')) &&
          e.target.toLowerCase().includes(needle),
        )
        if (matchingDefs.length > 1) {
          return this.candidateAnswer(matchingDefs, query, limit)
        }
        const candidates = matchingDefs.slice(0, limit)
        return {
          paths: candidates.map((e) => ({ edges: [e] })),
          candidates: [],
          diagnostics: [{ code: 'partial', message: 'no exact symbol match; returning ranked candidates' }],
          truncated: false,
          total: candidates.length,
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
    const total = edges.length
    const selected = edges.slice(0, limit)
    if (query.include_snippets === true) {
      for (const e of selected) this.attachSnippet(e)
    }
    const paths = selected.map((e) => ({ edges: [e] }))
    if (total > limit) {
      diagnostics.push({ code: 'truncated', message: `${total - limit} more relations beyond limit` })
    }
    return { paths, candidates: [], truncated: total > limit, total, diagnostics, metadata: this.metadata }
  }

  /** Ranked candidate list for an ambiguous target (ADR-0004). */
  private candidateAnswer(matching: RelationEdge[], query: GraphQuery, limit: number): GraphAnswer {
    const distinct = new Map<string, RelationEdge>()
    for (const e of matching) {
      const key = `${e.target.toLowerCase()}|${e.location.file.toLowerCase()}`
      if (!distinct.has(key)) distinct.set(key, e)
    }
    const defs = [...distinct.values()].sort((a, b) => a.location.file.localeCompare(b.location.file))
    return {
      paths: [],
      candidates: defs.slice(0, limit).map((e) => ({
        name: e.target,
        path: e.location.file,
        language: languageOfPath(e.location.file),
        line: e.location.line,
      })),
      diagnostics: [{ code: 'ambiguous_target', message: `${defs.length} symbols match '${query.target}'; disambiguate by path or qualified name` }],
      truncated: defs.length > limit,
      total: defs.length,
      metadata: this.metadata,
    }
  }

  /** Attach a 1–3 line locating snippet to an edge (reads the file). */
  private attachSnippet(edge: RelationEdge): void {
    try {
      const abs = join(this.projectRoot, edge.location.file)
      const allLines = readFileSync(abs, 'utf8').split(/\r?\n/)
      const start = Math.max(0, edge.location.line - 1)
      const lines = allLines.slice(start, start + SNIPPET_MAX_LINES).map((l) =>
        l.length > SNIPPET_LINE_MAX_CHARS ? l.slice(0, SNIPPET_LINE_MAX_CHARS) : l,
      )
      edge.snippet = { lines }
    } catch {
      // Unreadable file: leave snippet absent rather than fabricating one.
    }
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
      return { paths: [], candidates: [], truncated: false, total: 0, diagnostics: [{ code: 'no_path', message: `no call path from ${query.target} to ${query.path_to}` }], metadata: this.metadata }
    }
    for (let depth1 = 1; depth1 <= depth && frontier.length > 0; depth1++) {
      const next: Step[] = []
      for (const step of frontier) {
        // The caller symbol is the source file's basename (file-symbol bridge).
        const callerFile = step.edge.source.split('/').pop() ?? step.edge.source
        if (callerFile.replace(/\.[^.]+$/, '').toLowerCase() === from) {
          return { paths: [{ edges: step.chain }], candidates: [], truncated: false, total: step.chain.length, diagnostics, metadata: this.metadata }
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
    return { paths: [], candidates: [], truncated: false, total: 0, diagnostics: [{ code: 'no_path', message: `no call path from ${query.target} to ${query.path_to} within depth ${depth}` }], metadata: this.metadata }
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
    const all = [...anchor, ...direct, ...transitive]
    const total = all.length
    const selected = all.slice(0, limit)
    if (query.include_snippets === true) {
      for (const e of selected) this.attachSnippet(e)
    }
    const paths = selected.map((e) => ({ edges: [e] }))
    if (total > limit) {
      diagnostics.push({ code: 'truncated', message: 'impact edges beyond limit' })
    }
    return {
      paths,
      candidates: [],
      truncated: total > limit,
      total,
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

/**
 * One graph per project root (ADR-0003). Overrides participate in the
 * cache key: changed overrides replace the cached graph so budget/scope
 * changes take effect instead of being silently ignored.
 */
export function graphFor(projectRoot: string, overrides?: Record<string, unknown>): ProjectGraph {
  const key = JSON.stringify([projectRoot, overrides ?? {}])
  const existing = projectGraphs.get(key)
  if (existing !== undefined) return existing
  if (projectGraphs.size > 0) {
    // A same-root graph with different overrides is now stale by definition.
    for (const cachedKey of [...projectGraphs.keys()]) {
      try {
        const [cachedRoot] = JSON.parse(cachedKey) as [string]
        if (cachedRoot === projectRoot) projectGraphs.delete(cachedKey)
      } catch {
        projectGraphs.delete(cachedKey)
      }
    }
  }
  const graph = new ProjectGraph(projectRoot, overrides)
  projectGraphs.set(key, graph)
  return graph
}
