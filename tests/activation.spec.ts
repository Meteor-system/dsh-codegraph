import { describe, expect, it } from 'vitest'
import { apply as activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/testing.ts'

function makeCtx(opts?: { enabled?: boolean; projectRoot?: string }): FakeContext {
  const registrations: CapturedRegistration[] = []
  return {
    registrations,
    config: { enabled: opts?.enabled ?? false, projectRoot: opts?.projectRoot ?? '/proj' },
    captured: registrations,
  }
}

describe('CodeGraph bundle activation (single seam)', () => {
  it('registers exactly one tool named codegraph_explore when enabled', () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    expect(ctx.registrations).toHaveLength(1)
    expect(ctx.registrations[0].name).toBe('codegraph_explore')
  })

  it('registers nothing when the project has not enabled the plugin', () => {
    const ctx = makeCtx({ enabled: false })
    activate(ctx)
    expect(ctx.registrations).toHaveLength(0)
  })

  it('the returned disposer unregisters the tool', () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    const reg = ctx.registrations[0]
    expect(reg.disposed).toBe(false)
    reg.disposer()
    expect(reg.disposed).toBe(true)
  })

  it('a smoke call returns mode echo, empty paths, diagnostics array, and P1 capabilities metadata', async () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    const reg = ctx.registrations[0]
    const result = (await reg.execute({ mode: 'callers', target: 'foo' })) as {
      mode: string
      paths: unknown[]
      diagnostics: unknown[]
      metadata: { capabilities: Record<string, unknown>; index: { status: string } }
    }
    expect(result.mode).toBe('callers')
    expect(result.paths).toEqual([])
    expect(Array.isArray(result.diagnostics)).toBe(true)
    for (const lang of ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java']) {
      expect(result.metadata.capabilities[lang]).toEqual({ stage: 'P1', precision: 'syntax+inferred' })
    }
    expect(result.metadata.index.status).toBe('empty')
  })

  it('the tool description teaches the three modes, parameters, and diagnostics vocabulary', () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    const desc = ctx.registrations[0].description
    for (const term of ['reachability', 'callers', 'impact', 'max_depth', 'relation', 'confidence', 'limit', 'include_snippets', 'partial', 'unsupported_language', 'indexing', 'truncated']) {
      expect(desc).toContain(term)
    }
  })
})
