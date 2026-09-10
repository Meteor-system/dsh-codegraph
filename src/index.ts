/**
 * dsh-codegraph host entry.
 *
 * Standalone DSH bundle: mounts once per profile; on activation for a
 * project it registers exactly one agent tool, `codegraph_explore`, into
 * the agent's own tool context (never globally), per ADR-0002.
 */

import type { CodeGraphProjectConfig, FakeContext } from './contract.ts'

export const name = 'dsh-codegraph'

/** The three query modes (ADR-0002). */
const MODES = ['reachability', 'callers', 'impact'] as const

/** Impact depth: default 5, absolute hard cap 20 (spec: bounded closure). */
const IMPACT_DEFAULT_DEPTH = 5
const IMPACT_HARD_CAP = 20

/** Default result budget: 50 ranked relation paths, hard cap 200 (ADR-0004). */
const RESULT_DEFAULT_LIMIT = 50
const RESULT_HARD_CAP = 200

/** Languages committed for first delivery (spec: capability stage P1). */
const P1_CAPABILITIES: Record<string, { stage: 'P1'; precision: string }> = {
  typescript: { stage: 'P1', precision: 'syntax+inferred' },
  tsx: { stage: 'P1', precision: 'syntax+inferred' },
  javascript: { stage: 'P1', precision: 'syntax+inferred' },
  jsx: { stage: 'P1', precision: 'syntax+inferred' },
  python: { stage: 'P1', precision: 'syntax+inferred' },
  go: { stage: 'P1', precision: 'syntax+inferred' },
  rust: { stage: 'P1', precision: 'syntax+inferred' },
  java: { stage: 'P1', precision: 'syntax+inferred' },
}

const TOOL_DESCRIPTION = [
  'Query the project code graph. Three modes:',
  '- reachability: whether and how symbol X reaches symbol Y (ordered paths).',
  '- callers: who calls X (ordered relation paths).',
  '- impact: what changing X affects (bounded transitive closure, default depth 5, hard cap 20).',
  'Parameters: mode (required), target (required; symbol name, qualified name, or file:line),',
  'query (natural-language supplement), max_depth (default 5, cap 20),',
  'relation (definition|call|import|inherit|type-ref), confidence (exact|inferred|heuristic),',
  'scope, limit (default 50, hard cap 200), include_snippets.',
  'Every edge carries confidence; ambiguous targets return candidate lists.',
  'Diagnostics vocabulary: partial, unsupported_language, indexing, truncated, plus file-skip reasons.',
].join(' ')

/** Diagnostics codes are a closed enumeration (ADR-0004: no ad-hoc strings). */
export type DiagnosticCode =
  | 'partial'
  | 'unsupported_language'
  | 'indexing'
  | 'truncated'
  | 'invalid_mode'
  | 'file_oversize'
  | 'file_binary'
  | 'file_decode_failed'
  | 'file_count_stop'

export interface Diagnostic {
  code: DiagnosticCode
  message: string
}

/** Empty contract-shaped response body, shared by this ticket's smoke path. */
export interface ExploreResponse {
  mode: string
  paths: unknown[]
  diagnostics: Diagnostic[]
  metadata: {
    capabilities: Record<string, { stage: 'P1' | 'P2' | 'P3'; precision: string }>
    index: { status: string }
  }
}

/**
 * Activate the bundle against a host context.
 *
 * Registration is agent-scoped: the tool lands only in the context this
 * activation belongs to, and the returned disposer releases it (agent
 * disposal, HMR reload). Re-activation never duplicates: an existing
 * `codegraph_explore` registration is reused, not re-pushed (ticket AC 1).
 * A disabled — or absent — project configuration produces no registration
 * and no scanning: default is disabled (ticket AC 2, ADR-0003).
 */
export function activate(ctx: FakeContext): void {
  const config = ctx.config ?? { enabled: false, projectRoot: '' }
  if (!config.enabled) return

  const existing = ctx.registrations.find((r) => r.name === 'codegraph_explore')
  if (existing !== undefined) return

  const registration = {
    name: 'codegraph_explore',
    description: TOOL_DESCRIPTION,
    parametersSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: MODES },
        target: { type: 'string' },
        query: { type: 'string' },
        max_depth: { type: 'integer', minimum: 1, maximum: IMPACT_HARD_CAP, default: IMPACT_DEFAULT_DEPTH },
        relation: { type: 'string', enum: ['definition', 'call', 'import', 'inherit', 'type-ref'] },
        confidence: { type: 'string', enum: ['exact', 'inferred', 'heuristic'] },
        scope: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: RESULT_HARD_CAP, default: RESULT_DEFAULT_LIMIT },
        include_snippets: { type: 'boolean' },
      },
      required: ['mode', 'target'],
    },
    execute: async (input: unknown): Promise<ExploreResponse> => {
      const args = input as { mode?: string }
      // No silent fallback: an out-of-enum mode is a diagnostic, never a
      // coerced answer (spec: partial results + diagnostics beat guesses).
      if (args.mode === undefined || !(MODES as readonly string[]).includes(args.mode)) {
        return {
          mode: args.mode ?? '',
          paths: [],
          diagnostics: [{ code: 'invalid_mode', message: `mode must be one of ${MODES.join(', ')}` }],
          metadata: { capabilities: P1_CAPABILITIES, index: { status: 'empty' } },
        }
      }
      return {
        mode: args.mode,
        paths: [],
        diagnostics: [],
        metadata: {
          capabilities: P1_CAPABILITIES,
          index: { status: 'empty' },
        },
      }
    },
    disposed: false,
    disposer() {
      registration.disposed = true
      ctx.unregister(registration)
    },
  }

  ctx.registrations.push(registration)
}

// Re-export the seam types for test ergonomics.
export type { FakeContext, CapturedRegistration, CodeGraphProjectConfig } from './contract.ts'
