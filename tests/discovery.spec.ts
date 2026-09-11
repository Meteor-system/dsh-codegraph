import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-discovery-'))
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

interface Candidate {
  name: string
  path: string
  language: string
  line: number
}

function edgesOf(result: Record<string, unknown>): Edge[] {
  return (result.paths as Array<{ edges: Edge[] }>).flatMap((p) => p.edges)
}

function diagnosticsOf(result: Record<string, unknown>): Array<{ code: string; message: string }> {
  return result.diagnostics as Array<{ code: string; message: string }>
}

describe('symbol discovery (spec #17)', () => {
  it('unknown name is a miss: empty paths, empty candidates, diagnostic is not partial', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/store.ts': 'export function saveSnapshot(): void {}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'writeSnapshot' })
    expect(result.paths).toEqual([])
    expect(result.candidates).toEqual([])
    const codes = diagnosticsOf(result).map((d) => d.code)
    expect(codes.some((c) => c === 'partial')).toBe(false)
    expect(codes).toContain('unknown_target')
  })

  it('unique full name still runs callers without mixing a discovery walk', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/store.ts': 'export function saveSnapshot(): void {}\n',
      'src/app.ts': "import { saveSnapshot } from './store'\nexport function boot(): void { saveSnapshot() }\n",
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'saveSnapshot' })
    expect(result.candidates).toEqual([])
    const edges = edgesOf(result)
    expect(edges.some((e) => e.kind === 'definition' && e.target === 'saveSnapshot')).toBe(true)
    expect(edges.some((e) => e.kind === 'call' && e.target === 'saveSnapshot' && e.source.endsWith('src/app.ts'))).toBe(true)
    expect(diagnosticsOf(result).some((d) => d.code === 'ambiguous_target' || d.code === 'unknown_target')).toBe(false)
  })

  it('multiple definition sites return ranked candidates, empty paths, ambiguous_target', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/a/helper.ts': 'export function helper(): number { return 1 }\n',
      'src/b/helper.ts': 'export function helper(): string { return "x" }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'helper' })
    expect(result.paths).toEqual([])
    const candidates = result.candidates as Candidate[]
    expect(candidates.length).toBe(2)
    expect(candidates.every((c) => c.name === 'helper' && c.language === 'typescript')).toBe(true)
    expect(candidates.some((c) => c.path.replace(/\\/g, '/').endsWith('src/a/helper.ts'))).toBe(true)
    expect(candidates.some((c) => c.path.replace(/\\/g, '/').endsWith('src/b/helper.ts'))).toBe(true)
    expect(diagnosticsOf(result).some((d) => d.code === 'ambiguous_target')).toBe(true)
    expect(diagnosticsOf(result).some((d) => d.code === 'partial')).toBe(false)
  })

  it('block-scoped local is not a graph node', async () => {
    const ctx = activatedCtx(fixtureProject({
      'tests/store.spec.ts': 'export function testStore(): void {\n  const store = 1\n  void store\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'store' })
    expect(result.paths).toEqual([])
    expect(result.candidates).toEqual([])
    expect(diagnosticsOf(result).some((d) => d.code === 'unknown_target')).toBe(true)
  })

  it('unexported module-level declaration is discoverable by full name', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/index.ts': 'function hostTool(): void {}\nexport function activate(): void { hostTool() }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'hostTool' })
    const edges = edgesOf(result)
    expect(edges.some((e) => e.kind === 'definition' && e.target === 'hostTool')).toBe(true)
    expect(result.candidates).toEqual([])
    expect(diagnosticsOf(result).some((d) => d.code === 'unknown_target')).toBe(false)
  })

  it('methods are graph nodes named Owner.method', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/graph.ts': 'export class ProjectGraph {\n  answerWithTimeout(): void {}\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'ProjectGraph.answerWithTimeout' })
    const edges = edgesOf(result)
    expect(edges.some((e) => e.kind === 'definition' && e.target === 'ProjectGraph.answerWithTimeout')).toBe(true)
    expect(result.candidates).toEqual([])
    const byName = await explore(ctx, { mode: 'callers', target: 'answerWithTimeout' })
    const named = (byName.candidates as Candidate[]).length > 0
      ? (byName.candidates as Candidate[])
      : edgesOf(byName).filter((e) => e.kind === 'definition').map((e) => ({
        name: e.target, path: e.location.file, language: 'typescript', line: e.location.line,
      }))
    expect(named.some((c) => c.name === 'ProjectGraph.answerWithTimeout')).toBe(true)
  })

  it('short method name with several owners returns candidates, never a silent pick', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/graph.ts': 'export class ProjectGraph {\n  answerWithTimeout(): void {}\n}\n',
      'src/other.ts': 'export class OtherGraph {\n  answerWithTimeout(): void {}\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'answerWithTimeout' })
    expect(result.paths).toEqual([])
    const candidates = result.candidates as Candidate[]
    expect(candidates.map((c) => c.name).sort()).toEqual([
      'OtherGraph.answerWithTimeout',
      'ProjectGraph.answerWithTimeout',
    ])
    expect(diagnosticsOf(result).some((d) => d.code === 'ambiguous_target')).toBe(true)
  })

  it('schema mismatch rebuilds so old node identity is not mixed with new grain', async () => {
    const root = fixtureProject({
      'src/real.ts': 'export function real(): void {}\n',
    })
    mkdirSync(join(root, '.dsh', 'codegraph'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'codegraph', 'snapshot.json'), JSON.stringify({
      schemaVersion: 1,
      scanShapeHash: JSON.stringify([1_000_000, 50_000, [], []]),
      byFile: {
        'src/real.ts': [{
          kind: 'definition',
          source: 'src/real.ts',
          target: 'ghost',
          confidence: 'exact',
          location: { file: 'src/real.ts', line: 1, col: 1 },
        }],
      },
    }))
    const ctx = activatedCtx(root)
    const ghost = await explore(ctx, { mode: 'callers', target: 'ghost' })
    expect(ghost.paths).toEqual([])
    expect(ghost.candidates).toEqual([])
    expect(diagnosticsOf(ghost).some((d) => d.code === 'unknown_target')).toBe(true)
    const real = await explore(ctx, { mode: 'callers', target: 'real' })
    expect(edgesOf(real).some((e) => e.kind === 'definition' && e.target === 'real')).toBe(true)
  })

  it('file path as target lists graph nodes in that file and does not walk', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/index.ts': 'function hostTool(): void {}\nexport function activate(): void { hostTool() }\n',
      'src/other.ts': 'export function other(): void {}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'src/index.ts' })
    expect(result.paths).toEqual([])
    const candidates = result.candidates as Candidate[]
    expect(candidates.map((c) => c.name).sort()).toEqual(['activate', 'hostTool'])
    expect(candidates.every((c) => c.path.replace(/\\/g, '/') === 'src/index.ts')).toBe(true)
    expect(candidates.every((c) => c.language === 'typescript')).toBe(true)
    expect(diagnosticsOf(result).some((d) => d.code === 'ambiguous_target')).toBe(true)
  })

  it('directory prefix as target lists graph nodes under that path and does not walk', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/a/one.ts': 'export function one(): void {}\n',
      'src/a/nested/two.ts': 'export function two(): void {}\n',
      'src/b/three.ts': 'export function three(): void {}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'src/a' })
    expect(result.paths).toEqual([])
    const names = (result.candidates as Candidate[]).map((c) => c.name).sort()
    expect(names).toEqual(['one', 'two'])
  })

  it('scope does not change path discovery; it still filters a unique-node walk', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/a/helper.ts': 'export function helper(): number { return 1 }\n',
      'src/b/helper.ts': 'export function helper(): string { return "x" }\n',
    }))
    const discovered = await explore(ctx, { mode: 'callers', target: 'src/a/helper.ts', scope: 'src/b' })
    expect(discovered.paths).toEqual([])
    expect((discovered.candidates as Candidate[]).map((c) => c.name)).toEqual(['helper'])
    expect((discovered.candidates as Candidate[])[0].path.replace(/\\/g, '/')).toBe('src/a/helper.ts')

    const walked = await explore(ctx, { mode: 'callers', target: 'helper', scope: 'src/a' })
    // Unique after scope? Spec: scope filters a walk after a unique node.
    // Without unique node, helper is still ambiguous — scope must not pick.
    expect(walked.paths).toEqual([])
    expect((walked.candidates as Candidate[]).length).toBe(2)
  })

  it('file:line that lands on a graph node runs the requested mode for that node', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/graph.ts': 'export class ProjectGraph {\n  answerWithTimeout(): void {}\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'src/graph.ts:2' })
    expect(result.candidates).toEqual([])
    expect(edgesOf(result).some((e) => e.kind === 'definition' && e.target === 'ProjectGraph.answerWithTimeout')).toBe(true)
    const missLine = await explore(ctx, { mode: 'callers', target: 'src/graph.ts:99' })
    expect(missLine.paths).toEqual([])
    expect(missLine.candidates).toEqual([])
    expect(diagnosticsOf(missLine).some((d) => d.code === 'unknown_target')).toBe(true)
  })

  it('candidates rank non-test paths before test paths, then path, then line', async () => {
    const ctx = activatedCtx(fixtureProject({
      '__tests__/helper.ts': 'export function helper(): number { return 1 }\n',
      'src/z.ts': 'export function helper(): number { return 2 }\n',
      'src/a.ts': 'export class Alpha {\n  helper(): void {}\n}\nexport class Beta {\n  helper(): void {}\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'helper' })
    const candidates = result.candidates as Candidate[]
    const paths = candidates.map((c) => c.path.replace(/\\/g, '/'))
    expect(paths[paths.length - 1]).toBe('__tests__/helper.ts')
    expect(paths.slice(0, -1).every((p) => p.startsWith('src/'))).toBe(true)
    const srcA = candidates.filter((c) => c.path.replace(/\\/g, '/') === 'src/a.ts')
    expect(srcA.map((c) => c.line)).toEqual([...srcA.map((c) => c.line)].sort((a, b) => a - b))
    const srcPaths = [...new Set(paths.filter((p) => p.startsWith('src/')))]
    expect(srcPaths).toEqual([...srcPaths].sort((a, b) => a.localeCompare(b)))
  })

  it('test files stay in the graph and are discoverable by path', async () => {
    const ctx = activatedCtx(fixtureProject({
      'tests/host-apply.spec.ts': 'export function makeHost(): void {}\n',
      'src/prod.ts': 'export function prod(): void {}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'tests/host-apply.spec.ts' })
    expect(result.paths).toEqual([])
    expect((result.candidates as Candidate[]).some((c) => c.name === 'makeHost')).toBe(true)
  })

  it('candidate lists honor limit, truncated, and total like path results', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 8; i++) {
      files[`src/mod${i}.ts`] = `export function fn${i}(): void {}\n`
    }
    const ctx = activatedCtx(fixtureProject(files))
    const result = await explore(ctx, { mode: 'callers', target: 'src', limit: 3 })
    expect(result.paths).toEqual([])
    expect((result.candidates as Candidate[]).length).toBe(3)
    expect(result.total).toBe(8)
    expect(result.truncated).toBe(true)
    expect(diagnosticsOf(result).some((d) => d.code === 'truncated')).toBe(true)
  })
})
