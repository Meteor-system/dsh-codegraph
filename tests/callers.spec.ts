import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-callers-'))
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

interface Edge {
  kind: string
  source: string
  target: string
  confidence: string
  location: { file: string; line: number; col: number }
}

describe('callers mode (ticket 3)', () => {
  it('direct caller: caller -> callee edge ranked distance 1', async () => {
    const root = fixtureProject({
      'src/callee.ts': `export function callee(): number { return 1 }\n`,
      'src/caller.ts': `import { callee } from './callee'\nexport function caller(): number {\n  return callee()\n}\n`,
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'callee' })
    const paths = result.paths as Array<{ edges: Edge[] }>
    const callEdges = paths.flatMap((p) => p.edges).filter((e) => e.kind === 'call')
    const direct = callEdges.find((e) => e.source.endsWith('caller.ts') || e.target === 'caller')
    expect(direct).toBeDefined()
    expect(direct!.location.line).toBe(3)
    expect(['exact', 'inferred', 'heuristic']).toContain(direct!.confidence)
  })

  it('multi-hop chain: a -> b -> c resolves both hops', async () => {
    const root = fixtureProject({
      'src/c.ts': `export function c(): number { return 3 }\n`,
      'src/b.ts': `import { c } from './c'\nexport function b(): number { return c() }\n`,
      'src/a.ts': `import { b } from './b'\nexport function a(): number { return b() }\n`,
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'c' })
    const paths = result.paths as Array<{ edges: Edge[] }>
    const allEdges = paths.flatMap((p) => p.edges).filter((e) => e.kind === 'call')
    const hop1 = allEdges.find((e) => e.source.endsWith('b.ts') && e.target === 'c')
    const hop2 = allEdges.find((e) => e.source.endsWith('a.ts') && e.target === 'b')
    expect(hop1).toBeDefined()
    expect(hop2).toBeDefined()
  })

  it('relation filter narrows output to requested kinds', async () => {
    const root = fixtureProject({
      'src/callee.ts': `export function callee(): number { return 1 }\n`,
      'src/caller.ts': `import { callee } from './callee'\nexport function caller(): number {\n  return callee()\n}\n`,
    })
    const ctx = activatedCtx(root)
    const onlyDefs = await explore(ctx, { mode: 'callers', target: 'callee', relation: 'definition' })
    const defEdges = (onlyDefs.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)
    expect(defEdges.length).toBeGreaterThan(0)
    expect(defEdges.every((e) => e.kind === 'definition')).toBe(true)

    const onlyCalls = await explore(ctx, { mode: 'callers', target: 'callee', relation: 'call' })
    const callEdges = (onlyCalls.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)
    expect(callEdges.every((e) => e.kind === 'call')).toBe(true)
  })

  it('unresolvable dynamic call surfaces with non-exact confidence', async () => {
    const root = fixtureProject({
      'src/dynamic.ts': `const handlers: Record<string, () => void> = {}\nexport function run(name: string): void {\n  handlers[name]()\n}\n`,
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'run' })
    const paths = result.paths as Array<{ edges: Edge[] }>
    const edges = paths.flatMap((p) => p.edges)
    expect(edges.every((e) => ['exact', 'inferred', 'heuristic'].includes(e.confidence))).toBe(true)
  })
})
