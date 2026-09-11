/**
 * Relation graph model shared by all extraction adapters (ADR-0001/0005).
 * Adapter-agnostic: TS-family and tree-sitter extractions both produce
 * these nodes/edges; queries and the snapshot store never see ASTs.
 */

export type RelationKind = 'definition' | 'call' | 'import' | 'inherit' | 'type-ref'

export type Confidence = 'exact' | 'inferred' | 'heuristic'

export interface SymbolLocation {
  /** Project-relative path, forward slashes. */
  file: string
  line: number
  col: number
}

export interface RelationEdge {
  kind: RelationKind
  source: string
  target: string
  confidence: Confidence
  location: SymbolLocation
  /** Present only when the query sets include_snippets (ticket 6). */
  snippet?: Snippet
}

/** 1–3 locating lines from the edge's file; long lines truncated. */
export interface Snippet {
  lines: string[]
}

/** Max snippet line length (ADR-0004: lines > 10,000 chars are cut). */
export const SNIPPET_LINE_MAX_CHARS = 10_000

/** Lines fetched per snippet (ADR-0004: 1–3 locating lines). */
export const SNIPPET_MAX_LINES = 3

export interface RelationPath {
  edges: RelationEdge[]
}

/** Languages the v1 scan recognizes as source (spec: scan scope). */
export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.php', '.rb', '.bash', '.sh',
  '.hs', '.jl', '.scala', '.razor',
])

/** Default exclusion rules (ADR-0003: scan scope). */
export const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.dsh', '.cache', 'vendor', 'target',
  '.conda', 'conda', 'site-packages', '.venv', 'venv', '__pycache__',
  '.claude', '.npm', '.pnpm-store',
])

/** Snapshot schema version; bump forces a full rebuild (ADR-0003). */
export const SNAPSHOT_SCHEMA_VERSION = 4

/** Diagnostics codes are a closed enumeration (ADR-0004: no ad-hoc strings). */
export type DiagnosticCode =
  | 'partial'
  | 'unsupported_language'
  | 'indexing'
  | 'truncated'
  | 'invalid_mode'
  | 'no_path'
  | 'ambiguous_target'
  | 'unknown_target'
  | 'file_oversize'
  | 'file_binary'
  | 'file_decode_failed'
  | 'file_count_stop'

export interface Diagnostic {
  code: DiagnosticCode
  message: string
}

/** The closed diagnostic vocabulary (ADR-0004): no ad-hoc strings. */
export const DIAGNOSTIC_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'partial',
  'unsupported_language',
  'indexing',
  'truncated',
  'invalid_mode',
  'no_path',
  'ambiguous_target',
  'unknown_target',
  'file_oversize',
  'file_binary',
  'file_decode_failed',
  'file_count_stop',
])
