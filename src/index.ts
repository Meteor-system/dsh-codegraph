/**
 * dsh-codegraph host entry.
 *
 * Standalone DSH bundle: mounts once per profile; on activation for a
 * project it registers exactly one agent tool, `codegraph_explore`, into
 * the agent's own tool context (never globally), per ADR-0002.
 */

import type { CodeGraphProjectConfig, FakeContext } from './testing.ts'

export const name = 'dsh-codegraph'

/** Empty contract-shaped response body, shared by this ticket's smoke path. */
export interface ExploreResponse {
  mode: string
  paths: unknown[]
  diagnostics: unknown[]
  metadata: {
    capabilities: Record<string, { stage: 'P1' | 'P2' | 'P3'; precision: string }>
    index: { status: string }
  }
}

/** The three query modes (ADR-0002). */
const MODES = ['reachability', 'callers', 'impact'] as const

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
  '- impact: what changing X affects (bounded transitive closure, default depth 5).',
  'Parameters: mode (required), target (symbol name, qualified name, or file:line),',
  'query (natural-language supplement), max_depth, relation (definition|call|import|inherit|type-ref),',
  'confidence (exact|inferred|heuristic), scope, limit (default 50, hard cap 200), include_snippets.',
  'Every edge carries confidence; ambiguous targets return candidate lists.',
  'Diagnostics vocabulary: partial, unsupported_language, indexing, truncated, plus file-skip reasons.',
].join(' ')

/**
 * Activate the bundle against a host context.
 *
 * Registration is agent-scoped: the tool lands only in the context this
 * activation belongs to, and the returned disposer releases it (agent
 * disposal, HMR reload). A disabled project produces no registration and
 * no scanning (ADR-0002/0003).
 */
export function apply(ctx: FakeContext): void {
  const config: CodeGraphProjectConfig = ctx.config
  if (!config.enabled) return

  const registration = {
    name: 'codegraph_explore',
    description: TOOL_DESCRIPTION,
    parametersSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: MODES },
        target: { type: 'string' },
        query: { type: 'string' },
        max_depth: { type: 'integer', minimum: 1 },
        relation: { type: 'string', enum: ['definition', 'call', 'import', 'inherit', 'type-ref'] },
        confidence: { type: 'string', enum: ['exact', 'inferred', 'heuristic'] },
        scope: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        include_snippets: { type: 'boolean' },
      },
      required: ['mode'],
    },
    execute: async (input: unknown): Promise<ExploreResponse> => {
      const requested = (input as { mode?: string }).mode ?? 'reachability'
      const mode = (MODES as readonly string[]).includes(requested) ? requested : 'reachability'
      return {
        mode,
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
      const at = ctx.registrations.indexOf(registration)
      if (at !== -1) ctx.registrations.splice(at, 1)
    },
  }

  ctx.registrations.push(registration)
}

// Re-export the seam types for test ergonomics.
export type { FakeContext, CapturedRegistration, CodeGraphProjectConfig } from './testing.ts'
