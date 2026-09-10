import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-refresh-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function activatedCtx(projectRoot: string): FakeContext {
  const registrations: CapturedRegistration[] = []
  const ctx: FakeContext = {
    registrations,
    unregister(registration: CapturedRegistration) {
      const at = registrations.indexOf(registration)
      if (at !== -1) registrations.splice(at, 1)
    },
    config: { enabled: true, projectRoot },
  }
  activate(ctx)
  return ctx
}

function explore(ctx: FakeContext, input: unknown): Promise<Record<string, unknown>> {
  return ctx.registrations[0].execute(input) as Promise<Record<string, unknown>>
}

describe('incremental refresh (ticket 5)', () => {
  it('editing a file shows the new code without full rebuild (incremental metadata)', async () => {
    const root = fixtureProject({
      'src/one.ts': 'export function one(): number { return 1 }\n',
      'src/two.ts': 'export function two(): number { return 2 }\n',
    })
    const ctx = activatedCtx(root)
    await explore(ctx, { mode: 'callers', target: 'one' })
    // Edit: add a new function to two.ts; bump mtime so the fingerprint changes.
    const two = join(root, 'src', 'two.ts')
    writeFileSync(two, 'export function two(): number { return 2 }\nexport function fresh(): number { return 22 }\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(two, later, later)

    const result = await explore(ctx, { mode: 'callers', target: 'fresh' })
    const meta = result.metadata as { index: { status: string; refreshedFiles?: number } }
    expect(meta.index.status).toBe('incremental')
    expect(meta.index.refreshedFiles).toBe(1)
    const edges = (result.paths as Array<{ edges: Array<{ target: string }> }>).flatMap((p) => p.edges)
    expect(edges.some((e) => e.target === 'fresh')).toBe(true)
  })

  it('deleting a file removes its edges from subsequent answers', async () => {
    const root = fixtureProject({
      'src/one.ts': 'export function one(): number { return 1 }\n',
      'src/gone.ts': 'export function gone(): number { return 9 }\n',
    })
    const ctx = activatedCtx(root)
    const before = await explore(ctx, { mode: 'callers', target: 'gone' })
    expect((before.paths as unknown[]).length).toBeGreaterThan(0)

    rmSync(join(root, 'src', 'gone.ts'))
    const after = await explore(ctx, { mode: 'callers', target: 'gone' })
    expect(after.paths).toEqual([])
    expect((after.diagnostics as Array<{ code: string }>).some((d) => d.code === 'partial')).toBe(true)
  })

  it('concurrent queries during refresh are serialized single-flight, both consistent', async () => {
    const root = fixtureProject({ 'src/one.ts': 'export function one(): number { return 1 }\n' })
    const ctx = activatedCtx(root)
    await explore(ctx, { mode: 'callers', target: 'one' })
    const two = join(root, 'src', 'two.ts')
    writeFileSync(two, 'export function two(): number { return 2 }\nexport function twin(): number { return 22 }\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(two, later, later)

    const [r1, r2] = await Promise.all([
      explore(ctx, { mode: 'callers', target: 'twin' }),
      explore(ctx, { mode: 'callers', target: 'twin' }),
    ])
    for (const r of [r1, r2]) {
      const edges = (r.paths as Array<{ edges: Array<{ target: string }> }>).flatMap((p) => p.edges)
      expect(edges.some((e) => e.target === 'twin')).toBe(true)
    }
  })

  it('a refresh exceeding the tool timeout returns indexing status with retry guidance', async () => {
    const root = fixtureProject({ 'src/one.ts': 'export function one(): number { return 1 }\n' })
    // Simulate a slow scan: a file whose mtime is in the future and a
    // refresh timeout far below the scan cost is approximated by a
    // project-level budget file; here we use the contract's timeout knob.
    const ctx = activatedCtx(root)
    await explore(ctx, { mode: 'callers', target: 'one' })
    const slow = join(root, 'src', 'slow.ts')
    writeFileSync(slow, 'export function slow(): number { return 3 }\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(slow, later, later)

    const result = await explore(ctx, { mode: 'callers', target: 'slow', refresh_timeout_ms: 0 })
    const meta = result.metadata as { index: { status: string; progress?: unknown; retryAfterMs?: number } }
    expect(meta.index.status).toBe('indexing')
    expect(meta.index.progress).toBeDefined()
    expect(meta.index.retryAfterMs).toBeGreaterThan(0)
    const diag = result.diagnostics as Array<{ code: string }>
    expect(diag.some((d) => d.code === 'indexing')).toBe(true)

    // Subsequent call without the timeout completes and answers.
    const done = await explore(ctx, { mode: 'callers', target: 'slow' })
    const edges = (done.paths as Array<{ edges: Array<{ target: string }> }>).flatMap((p) => p.edges)
    expect(edges.some((e) => e.target === 'slow')).toBe(true)
  })
})
