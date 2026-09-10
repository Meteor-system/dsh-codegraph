import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-mono-'))
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

/** packages/api (defines hub + util), packages/app (imports and calls), packages/standalone (island). */
const MONO: Record<string, string> = {
  'package.json': '{"name":"@repo/root","workspaces":["packages/*"]}\n',
  'packages/api/package.json': '{"name":"@repo/api"}\n',
  'packages/api/src/hub.ts': 'export function hub(): number { return 1 }\n',
  'packages/api/src/util.ts': 'export function util(x: number): number { return x * 2 }\n',
  'packages/app/package.json': '{"name":"@repo/app"}\n',
  'packages/app/src/main.ts': "import { hub, util } from '@repo/api/src/hub'\nexport function main(): number { return util(hub()) }\n",
  'packages/standalone/package.json': '{"name":"@repo/standalone"}\n',
  'packages/standalone/src/solo.ts': 'export function solo(): number { return 3 }\n',
}

describe('monorepo scope (ticket 8)', () => {
  it('one graph holds all packages; symbols resolve to their package', async () => {
    const ctx = activatedCtx(fixtureProject(MONO))
    const result = await explore(ctx, { mode: 'callers', target: 'hub' })
    const meta = result.metadata as { packages?: Record<string, string> }
    expect(meta.packages).toBeDefined()
    expect(meta.packages!['packages/api']).toBe('package')
    expect(meta.packages!['packages/app']).toBe('package')
    expect(meta.packages!['packages/standalone']).toBe('package')
    const edges = (result.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges).filter((e) => e.kind === 'call')
    expect(edges.some((e) => e.source.startsWith('packages/app/'))).toBe(true)
  })

  it('scope by package prefix restricts results to that package', async () => {
    const ctx = activatedCtx(fixtureProject(MONO))
    const result = await explore(ctx, { mode: 'callers', target: 'util', scope: 'packages/api' })
    const edges = (result.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every((e) => e.location.file.startsWith('packages/api/'))).toBe(true)
  })

  it('scope by path prefix restricts results to that subtree', async () => {
    const ctx = activatedCtx(fixtureProject(MONO))
    const result = await explore(ctx, { mode: 'callers', target: 'main', scope: 'packages/app/src' })
    const edges = (result.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every((e) => e.location.file.startsWith('packages/app/src/'))).toBe(true)
  })

  it('cross-package imports appear and are filterable by relation import', async () => {
    const ctx = activatedCtx(fixtureProject(MONO))
    const result = await explore(ctx, { mode: 'callers', target: 'hub.ts', relation: 'import' })
    const edges = (result.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges).filter((e) => e.kind === 'import')
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.some((e) => e.source.startsWith('packages/app/') && e.target.startsWith('packages/api/'))).toBe(true)
  })

  it('impact on a shared symbol crosses package boundaries', async () => {
    const ctx = activatedCtx(fixtureProject(MONO))
    const result = await explore(ctx, { mode: 'impact', target: 'hub' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
    // hub is called from packages/app (cross-package, via the file-symbol
    // bridge main() in packages/app/src/main.ts).
    expect(meta.impact!.direct.length + meta.impact!.transitive.length).toBeGreaterThan(0)
    const crossPackage = [...meta.impact!.direct, ...meta.impact!.transitive].some((name) => name === 'main')
    expect(crossPackage).toBe(true)
  })
})
