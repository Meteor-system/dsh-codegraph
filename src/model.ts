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
}

export interface RelationPath {
  edges: RelationEdge[]
}

/** Languages the v1 scan recognizes as source (spec: scan scope). */
export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.php', '.rb', '.bash', '.sh',
  '.hs', '.jl', '.scala',
])

/** Default exclusion rules (ADR-0003: scan scope). */
export const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.dsh', '.cache', 'vendor', 'target',
])

/** Snapshot schema version; bump forces a full rebuild (ADR-0003). */
export const SNAPSHOT_SCHEMA_VERSION = 1

/** Diagnostics codes are a closed enumeration (ADR-0004: no ad-hoc strings). */
export type DiagnosticCode =
  | 'partial'
  | 'unsupported_language'
  | 'indexing'
  | 'truncated'
  | 'invalid_mode'
  | 'no_path'
  | 'file_oversize'
  | 'file_binary'
  | 'file_decode_failed'
  | 'file_count_stop'

export interface Diagnostic {
  code: DiagnosticCode
  message: string
}
