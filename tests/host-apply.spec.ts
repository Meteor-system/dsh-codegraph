import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../src/index.ts'
import type { HostContext, HostToolDefinition } from '../src/contract.ts'

function makeHost(): { ctx: HostContext; registrations: HostToolDefinition[] } {
  const registrations: HostToolDefinition[] = []
  return {
    registrations,
    ctx: {
      tools: {
        register(definition) {
          registrations.push(definition)
          return () => {
            const at = registrations.indexOf(definition)
            if (at !== -1) registrations.splice(at, 1)
          }
        },
      },
    },
  }
}

describe('host apply (cordis plugin shape)', () => {
  it('exports apply, inject, and the package name the loader resolves', () => {
    expect(name).toBe('dsh-codegraph')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
  })

  it('registers nothing when disabled (the default)', () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { projectRoot: '/proj' })
    expect(registrations).toHaveLength(0)
  })

  it('registers codegraph_explore on ctx.tools when enabled', () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    expect(registrations).toHaveLength(1)
    expect(registrations[0].name).toBe('codegraph_explore')
    expect(registrations[0].timeoutMs).toBe(300_000)
    expect(typeof registrations[0].execute).toBe('function')
    expect(typeof registrations[0].output.render).toBe('function')
  })

  it('indexes the session cwd rather than the apply-time process cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-cwd-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'one.ts'), 'export function sessionOnly(): number { return 1 }\n')
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/this/is/not/the/project' })
    const result = await registrations[0].execute(
      { mode: 'callers', target: 'sessionOnly' },
      { agent: { session: { header: { cwd: root } } } },
    ) as { paths: unknown[] }
    expect(result.paths.length).toBeGreaterThan(0)
  })

  it('host execute returns lossless JSON (no undefined fields)', async () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    const result = await registrations[0].execute({ mode: 'callers', target: 'apply' }) as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(Object.prototype.hasOwnProperty.call(result.metadata as object, 'impact')).toBe(false)
  })

  it('an already-aborted host signal returns indexing instead of hanging', async () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    const ac = new AbortController()
    ac.abort()
    const result = await registrations[0].execute({ mode: 'callers', target: 'apply' }, { signal: ac.signal }) as {
      diagnostics: Array<{ code: string }>
      metadata: { index: { status: string } }
    }
    expect(result.diagnostics.some((d) => d.code === 'indexing')).toBe(true)
    expect(result.metadata.index.status).toBe('indexing')
  })

  it('re-activation does not duplicate the host registration', () => {
    const { ctx, registrations } = makeHost()
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    apply(ctx, { enabled: true, projectRoot: '/proj' })
    expect(registrations).toHaveLength(1)
  })
})
