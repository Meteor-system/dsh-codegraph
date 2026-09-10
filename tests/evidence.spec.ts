import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-evidence-'))
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

describe('evidence contract (ticket 6)', () => {
  it('fixtures produce all three confidence labels', async () => {
    const root = fixtureProject({
      // exact: same-file call (inner); inferred: cross-file import-name
      // call (callee); heuristic: callback invocation — `cb` is a
      // parameter, it has no definition edge anywhere.
      'src/callee.ts': 'export function callee(): number { return 1 }\n',
      'src/caller.ts': "import { callee } from './callee'\nfunction inner(): number { return 7 }\nexport function caller(): number {\n  const a = inner()\n  const b = callee()\n  return a + b\n}\nexport function runner(cb: () => void): void {\n  cb()\n}\n",
    })
    const ctx = activatedCtx(root)
    const sameFile = await explore(ctx, { mode: 'callers', target: 'inner', relation: 'call' })
    const crossFile = await explore(ctx, { mode: 'callers', target: 'callee', relation: 'call' })
    const dynamic = await explore(ctx, { mode: 'callers', target: 'cb', relation: 'call' })
    const labels = new Set<string>()
    for (const r of [sameFile, crossFile, dynamic]) {
      for (const e of (r.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)) labels.add(e.confidence)
    }
    expect(labels.has('exact')).toBe(true)
    expect(labels.has('inferred')).toBe(true)
    expect(labels.has('heuristic')).toBe(true)
  })

  it('confidence filter narrows output to the requested label', async () => {
    const root = fixtureProject({
      'src/callee.ts': 'export function callee(): number { return 1 }\n',
      'src/caller.ts': "import { callee } from './callee'\nexport function caller(): number {\n  return callee()\n}\n",
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'caller', relation: 'call', confidence: 'exact' })
    const edges = (result.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every((e) => e.confidence === 'exact')).toBe(true)
  })

  it('ambiguous symbol returns ranked candidates, never a silent pick', async () => {
    const root = fixtureProject({
      'src/a/helper.ts': 'export function helper(): number { return 1 }\n',
      'src/b/helper.ts': 'export function helper(): string { return "x" }\n',
      'src/b/deep/helper.ts': 'export function helper(): boolean { return true }\n',
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'helper' })
    const candidates = result.candidates as Array<{ name: string; path: string; language: string; line: number }>
    expect(Array.isArray(candidates)).toBe(true)
    expect(candidates.length).toBe(3)
    expect(candidates.every((c) => c.name === 'helper' && c.language === 'typescript')).toBe(true)
    expect(candidates.some((c) => c.path.endsWith('a/helper.ts'))).toBe(true)
    const diag = result.diagnostics as Array<{ code: string }>
    expect(diag.some((d) => d.code === 'ambiguous_target')).toBe(true)
  })

  it('>50 paths return 50 by default with truncated flag and total count', async () => {
    // 60 modules each call the shared hub; querying the hub's callers
    // yields 60 call edges, budgeted to 50 by default.
    const files: Record<string, string> = {
      'src/hub.ts': 'export function hub(): number { return 0 }\n',
    }
    for (let i = 0; i < 60; i++) {
      files[`src/mod${i}.ts`] = `import { hub } from './hub'\nexport function mod${i}(): number { return hub() }\n`
    }
    const ctx = activatedCtx(fixtureProject(files))
    const result = await explore(ctx, { mode: 'callers', target: 'hub' })
    expect(result.total).toBe(61) // 60 call edges + 1 anchor definition
    expect((result.paths as unknown[]).length).toBe(50)
    expect(result.truncated).toBe(true)
  })

  it('limit raises within the 200 hard cap; over-cap clamps with a diagnostic', async () => {
    const files: Record<string, string> = {
      'src/hub.ts': 'export function hub(): number { return 0 }\n',
    }
    for (let i = 0; i < 60; i++) {
      files[`src/mod${i}.ts`] = `import { hub } from './hub'\nexport function mod${i}(): number { return hub() }\n`
    }
    const ctx = activatedCtx(fixtureProject(files))
    const raised = await explore(ctx, { mode: 'callers', target: 'hub', limit: 55 })
    expect((raised.paths as unknown[]).length).toBe(55)
    expect(raised.truncated).toBe(true)

    const over = await explore(ctx, { mode: 'callers', target: 'hub', limit: 500 })
    const diag = over.diagnostics as Array<{ code: string; message: string }>
    expect(diag.some((d) => d.message.includes('clamped'))).toBe(true)
  })

  it('include_snippets adds 1-3 locating lines; default output has none', async () => {
    const root = fixtureProject({
      'src/one.ts': 'export function one(): number {\n  const x = 1\n  return x\n}\n',
    })
    const ctx = activatedCtx(root)
    const bare = await explore(ctx, { mode: 'callers', target: 'one' })
    const bareEdges = (bare.paths as Array<{ edges: Array<{ snippet?: unknown }> }>).flatMap((p) => p.edges)
    expect(bareEdges.every((e) => e.snippet === undefined)).toBe(true)

    const withSnip = await explore(ctx, { mode: 'callers', target: 'one', include_snippets: true })
    const snipEdges = (withSnip.paths as Array<{ edges: Array<{ snippet?: { lines: string[] } }> }>).flatMap((p) => p.edges)
    expect(snipEdges.length).toBeGreaterThan(0)
    for (const e of snipEdges) {
      expect(e.snippet).toBeDefined()
      expect(e.snippet!.lines.length).toBeGreaterThanOrEqual(1)
      expect(e.snippet!.lines.length).toBeLessThanOrEqual(3)
    }
  })

  it('lines over 10000 chars are truncated in snippet output', async () => {
    const longLine = 'const pad = "' + 'x'.repeat(12000) + '"\n'
    const root = fixtureProject({
      'src/long.ts': `export function longfn(): number {\n${longLine}  return 1\n}\n`,
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'longfn', include_snippets: true })
    const edges = (result.paths as Array<{ edges: Array<{ snippet?: { lines: string[] } }> }>).flatMap((p) => p.edges)
    expect(edges.length).toBeGreaterThan(0)
    for (const e of edges) {
      for (const line of e.snippet!.lines) {
        expect(line.length).toBeLessThanOrEqual(10_000)
      }
    }
  })
})

