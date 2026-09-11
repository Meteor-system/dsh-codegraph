import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-p3-'))
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

function edgesOf(result: Record<string, unknown>): Edge[] {
  return (result.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)
}

/**
 * Hand-verified P3 fixtures (ticket 11 / #12).
 *
 * haskell  src/Main.hs     greet 0            call exact → greet
 * julia    src/main.jl     greet()            call exact → greet
 * scala    src/Main.scala  Child extends Base inherit exact → Base
 *                          greet()            call exact → greet
 * razor    src/Page.razor  no extraction; unsupported_language + markup-reduced
 */
describe('P3 languages (ticket 11)', () => {
  it('haskell: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Main.hs': 'greet :: Int -> Int\ngreet x = x + 1\nrun :: Int\nrun = greet 0\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('haskell: impact answers through the standard contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Main.hs': 'greet :: Int -> Int\ngreet x = x + 1\nrun :: Int\nrun = greet 0\n',
    }))
    const result = await explore(ctx, { mode: 'impact', target: 'greet' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
    expect(meta.impact).toBeDefined()
    expect(meta.impact!.direct.length + meta.impact!.transitive.length).toBeGreaterThan(0)
  }, 30_000)

  it('julia: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.jl': 'function greet()\n    1\nend\nfunction run()\n    greet()\nend\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('julia: impact answers through the standard contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.jl': 'function greet()\n    1\nend\nfunction run()\n    greet()\nend\n',
    }))
    const result = await explore(ctx, { mode: 'impact', target: 'greet' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
    expect(meta.impact).toBeDefined()
    expect(meta.impact!.direct.length + meta.impact!.transitive.length).toBeGreaterThan(0)
  }, 30_000)

  it('scala: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Main.scala': 'object Main {\n  def greet(): Int = 1\n  def run(): Int = greet()\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('scala: inheritance edges extract per language semantics', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Main.scala': 'class Base\nclass Child extends Base\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'Base', relation: 'inherit' })
    const edges = edgesOf(result).filter((e) => e.kind === 'inherit')
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every((e) => e.target === 'Base')).toBe(true)
  }, 30_000)

  it('scala: impact answers through the standard contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Main.scala': 'object Main {\n  def greet(): Int = 1\n  def run(): Int = greet()\n}\n',
    }))
    const result = await explore(ctx, { mode: 'impact', target: 'greet' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
    expect(meta.impact).toBeDefined()
    expect(meta.impact!.direct.length + meta.impact!.transitive.length).toBeGreaterThan(0)
  }, 30_000)

  it('razor: .razor files yield unsupported_language with reduced precision advertised', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Page.razor': '@page "/"\n<button @onclick="Run">go</button>\n@code {\n    int Run() => 1;\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'Run' })
    const diags = result.diagnostics as Array<{ code: string; message: string }>
    expect(diags.some((d) => d.code === 'unsupported_language' || d.code === 'partial')).toBe(true)
    const caps = (result.metadata as { capabilities: Record<string, { stage: string; precision: string }> }).capabilities
    expect(caps.razor.stage).toBe('P3')
    expect(caps.razor.precision).not.toBe('syntax+inferred')
  }, 30_000)

  it('capabilities metadata includes the four P3 languages', async () => {
    const ctx = activatedCtx(fixtureProject({ 'src/one.ts': 'export function one(): number { return 1 }\n' }))
    const result = await explore(ctx, { mode: 'callers', target: 'one' })
    const caps = (result.metadata as { capabilities: Record<string, { stage: string; precision: string }> }).capabilities
    expect(caps.haskell).toEqual({ stage: 'P3', precision: 'syntax+inferred' })
    expect(caps.julia).toEqual({ stage: 'P3', precision: 'syntax+inferred' })
    expect(caps.scala).toEqual({ stage: 'P3', precision: 'syntax+inferred' })
    expect(caps.razor).toEqual({ stage: 'P3', precision: 'markup-reduced' })
  })
})
