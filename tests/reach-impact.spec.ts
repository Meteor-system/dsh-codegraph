import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-reach-'))
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

/** Chain fixture: a -> b -> c -> d (call edges through file-named symbols). */
const CHAIN: Record<string, string> = {
  'src/d.ts': 'export function d(): number { return 4 }\n',
  'src/c.ts': "import { d } from './d'\nexport function c(): number { return d() }\n",
  'src/b.ts': "import { c } from './c'\nexport function b(): number { return c() }\n",
  'src/a.ts': "import { b } from './b'\nexport function a(): number { return b() }\n",
}

describe('reachability mode (ticket 4)', () => {
  it('returns an ordered path when X reaches Y', async () => {
    const ctx = activatedCtx(fixtureProject(CHAIN))
    const result = await explore(ctx, { mode: 'reachability', target: 'a', path_to: 'd' })
    const paths = result.paths as Array<{ edges: Edge[] }>
    expect(paths.length).toBeGreaterThan(0)
    const flat = paths.flatMap((p) => p.edges).map((e) => e.target)
    expect(flat).toContain('b')
    expect(flat).toContain('c')
    expect(flat).toContain('d')
  })

  it('an absent path is a definitive empty answer with a diagnostic, not an error', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/island.ts': 'export function island(): number { return 1 }\n',
      'src/other.ts': 'export function other(): number { return 2 }\n',
    }))
    const result = await explore(ctx, { mode: 'reachability', target: 'island', path_to: 'other' })
    expect(result.paths).toEqual([])
    const diag = result.diagnostics as Array<{ code: string }>
    expect(diag.some((d) => d.code === 'no_path')).toBe(true)
  })
})

describe('impact mode (ticket 4)', () => {
  it('default depth 5; direct and transitive layers distinguishable', async () => {
    const ctx = activatedCtx(fixtureProject(CHAIN))
    const result = await explore(ctx, { mode: 'impact', target: 'd' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[]; maxDepth: number } }
    expect(meta.impact).toBeDefined()
    expect(meta.impact!.direct).toContain('c')
    expect(meta.impact!.transitive).toContain('b')
    expect(meta.impact!.transitive).toContain('a')
    expect(meta.impact!.maxDepth).toBe(5)
  })

  it('max_depth adjustable; over-cap clamped with a diagnostic', async () => {
    const ctx = activatedCtx(fixtureProject(CHAIN))
    const capped = await explore(ctx, { mode: 'impact', target: 'd', max_depth: 1 })
    let meta = capped.metadata as { impact?: { direct: string[]; transitive: string[]; maxDepth: number } }
    expect(meta.impact!.direct).toContain('c')
    expect(meta.impact!.transitive).not.toContain('a')

    const over = await explore(ctx, { mode: 'impact', target: 'd', max_depth: 999 })
    meta = over.metadata as { impact?: { direct: string[]; transitive: string[]; maxDepth: number } }
    expect(meta.impact!.maxDepth).toBe(20)
    const diag = over.diagnostics as Array<{ code: string; message: string }>
    expect(diag.some((d) => d.code === 'partial' && d.message.includes('clamped'))).toBe(true)
  })

  it('cycles terminate with bounded results', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/x.ts': "import { y } from './y'\nexport function x(): number { return y() }\n",
      'src/y.ts': "import { x } from './x'\nexport function y(): number { return x() }\n",
    }))
    const result = await explore(ctx, { mode: 'impact', target: 'x' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
    expect(meta.impact).toBeDefined()
    expect(meta.impact!.direct).toContain('y')
    expect(meta.impact!.transitive).toContain('x')
  })

  it('mid-chain impact matches hand-verified fixture expectations', async () => {
    const ctx = activatedCtx(fixtureProject(CHAIN))
    const result = await explore(ctx, { mode: 'impact', target: 'c' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
    expect(meta.impact!.direct).toEqual(['b'])
    expect(meta.impact!.transitive).toEqual(['a'])
  })
})
