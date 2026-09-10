import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'

function makeCtx(opts?: { enabled?: boolean; omitConfig?: boolean }): FakeContext {
  const registrations: CapturedRegistration[] = []
  return {
    registrations,
    unregister(registration: CapturedRegistration) {
      const at = registrations.indexOf(registration)
      if (at !== -1) registrations.splice(at, 1)
    },
    config: opts?.omitConfig ? (undefined as never) : { enabled: opts?.enabled ?? false, projectRoot: '/proj' },
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

  it('defaults to disabled when project configuration is absent', () => {
    const ctx = makeCtx({ omitConfig: true })
    expect(() => activate(ctx)).not.toThrow()
    expect(ctx.registrations).toHaveLength(0)
  })

  it('re-activation does not duplicate the registration', () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    activate(ctx)
    activate(ctx)
    expect(ctx.registrations).toHaveLength(1)
  })

  it('the returned disposer unregisters the tool', () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    const reg = ctx.registrations[0]
    expect(reg.disposed).toBe(false)
    reg.disposer()
    expect(reg.disposed).toBe(true)
    expect(ctx.registrations).toHaveLength(0)
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

  it('an out-of-enum mode returns an invalid_mode diagnostic, not a coerced answer', async () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    const reg = ctx.registrations[0]
    const result = (await reg.execute({ mode: 'nonsense', target: 'foo' })) as {
      mode: string
      paths: unknown[]
      diagnostics: Array<{ code: string; message: string }>
    }
    expect(result.mode).toBe('nonsense')
    expect(result.paths).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].code).toBe('invalid_mode')
  })

  it('the schema requires both mode and target', () => {
    const ctx = makeCtx({ enabled: true })
    activate(ctx)
    const schema = ctx.registrations[0].parametersSchema as { required: string[]; properties: Record<string, { maximum?: number; default?: number }> }
    expect(schema.required).toEqual(['mode', 'target'])
    expect(schema.properties.max_depth.maximum).toBe(20)
    expect(schema.properties.max_depth.default).toBe(5)
    expect(schema.properties.limit.maximum).toBe(200)
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
