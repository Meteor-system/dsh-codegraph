import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Build a throwaway fixture project; return its root. */
function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-fixture-'))
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

describe('lazy index (ticket 2)', () => {
  it('first call builds the index and returns definition relations with locations', async () => {
    const root = fixtureProject({
      'src/greet.ts': `export function greet(name: string): string {\n  return 'hello ' + name\n}\n`,
      'src/limbo.ts': `export const unused = 1\n`,
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const paths = result.paths as Array<{ edges: Array<{ kind: string; source: string; target: string; location: { file: string; line: number; col: number } }> }>
    const defs = paths.flatMap((p) => p.edges).filter((e) => e.kind === 'definition')
    expect(defs.length).toBeGreaterThanOrEqual(1)
    const greetDef = defs.find((e) => e.target === 'greet')
    expect(greetDef).toBeDefined()
    expect(greetDef!.location.file.replace(/\\/g, '/')).toMatch(/src\/greet\.ts$/)
    expect(greetDef!.location.line).toBe(1)
  })

  it('import relations resolve across files to the defining module', async () => {
    const root = fixtureProject({
      'src/math-util.ts': `export function add(a: number, b: number): number { return a + b }\n`,
      'src/app.ts': `import { add } from './math-util'\nexport const sum = add(1, 2)\n`,
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'math-util.ts', relation: 'import' })
    const edges = (result.paths as Array<{ edges: Array<{ kind: string; source: string; target: string }> }>).flatMap((p) => p.edges)
    const imports = edges.filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/app.ts') && e.target.endsWith('src/math-util.ts'))).toBe(true)
  })

  it('second call reuses the snapshot (metadata status reused, not rebuilt)', async () => {
    const root = fixtureProject({ 'src/one.ts': `export function one() {}\n` })
    const ctx = activatedCtx(root)
    await explore(ctx, { mode: 'callers', target: 'one' })
    const second = await explore(ctx, { mode: 'callers', target: 'one' })
    expect((second.metadata as { index: { status: string } }).index.status).toBe('reused')
  })

  it('a tampered schema version forces a full rebuild (status rebuilt)', async () => {
    const root = fixtureProject({ 'src/one.ts': `export function one() {}\n` })
    const ctx = activatedCtx(root)
    await explore(ctx, { mode: 'callers', target: 'one' })
    const store = join(root, '.dsh', 'codegraph', 'snapshot.json')
    const snap = JSON.parse(readFileSync(store, 'utf8'))
    snap.schemaVersion = 999
    writeFileSync(store, JSON.stringify(snap))
    // Version validation happens at snapshot load; a fresh session (new
    // ProjectGraph, as the executor does for a new process) must rebuild.
    const { ProjectGraph } = await import('../src/graph.ts')
    const fresh = new ProjectGraph(root)
    const answer = fresh.answer({ mode: 'callers', target: 'one' })
    expect((answer.metadata as { index: { status: string } }).index.status).toBe('rebuilt')
  })

  it('scan respects ignore rules: dependency/build/cache dirs are absent', async () => {
    const root = fixtureProject({
      'src/real.ts': `export function real() {}\n`,
      'node_modules/pkg/index.ts': `export function dependency() {}\n`,
      'dist/bundle.js': `function bundled() {}\n`,
      '.dsh/codegraph/stale.ts': `export function cached() {}\n`,
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'dependency' })
    expect((result.paths as unknown[]).length).toBe(0)
    const all = await explore(ctx, { mode: 'callers', target: 'real' })
    expect((all.paths as unknown[]).length).toBeGreaterThan(0)
  })
})
