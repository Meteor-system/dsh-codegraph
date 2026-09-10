import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-diag-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function activatedCtx(projectRoot: string, overrides?: Record<string, unknown>): FakeContext {
  const registrations: CapturedRegistration[] = []
  const ctx: FakeContext = {
    registrations,
    unregister(registration: CapturedRegistration) {
      const at = registrations.indexOf(registration)
      if (at !== -1) registrations.splice(at, 1)
    },
    config: { enabled: true, projectRoot, overrides },
  }
  activate(ctx)
  return ctx
}

function explore(ctx: FakeContext, input: unknown): Promise<Record<string, unknown>> {
  return ctx.registrations[0].execute(input) as Promise<Record<string, unknown>>
}

describe('diagnostics and budgets (ticket 7)', () => {
  it('oversize file skipped with a diagnostic; project override adjusts the cap', async () => {
    const big = 'x'.repeat(1_100_000)
    const root = fixtureProject({
      'src/big.ts': `export const big = '${big}'\nexport function bigFn(): number { return 1 }\n`,
      'src/small.ts': 'export function small(): number { return 2 }\n',
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'small' })
    const diag = result.diagnostics as Array<{ code: string; message: string }>
    expect(diag.some((d) => d.code === 'file_oversize')).toBe(true)
    // big.ts contents absent from the graph
    const bigResult = await explore(ctx, { mode: 'callers', target: 'bigFn' })
    expect((bigResult.paths as unknown[]).length).toBe(0)

    // Override: raise the cap; the file indexes now.
    const ctx2 = activatedCtx(root, { max_file_bytes: 2_000_000 })
    const overridden = await explore(ctx2, { mode: 'callers', target: 'bigFn' })
    expect((overridden.paths as unknown[]).length).toBeGreaterThan(0)
  })

  it('binary file skipped with a diagnostic', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe])
    const root = fixtureProject({
      'src/blob.ts': binary,
      'src/real.ts': 'export function real(): number { return 1 }\n',
    })
    const ctx = activatedCtx(root)
    const result = await explore(ctx, { mode: 'callers', target: 'real' })
    const diag = result.diagnostics as Array<{ code: string; message: string }>
    expect(diag.some((d) => d.code === 'file_binary')).toBe(true)
  })

  it('file-count stop produces a diagnostic; project override works', async () => {
    const files: Record<string, string> = { 'src/anchor.ts': 'export function anchor(): number { return 0 }\n' }
    for (let i = 0; i < 12; i++) {
      files[`src/gen${i}.ts`] = `export function gen${i}(): number { return ${i} }\n`
    }
    const ctx = activatedCtx(root(files), { max_files: 5 })
    const result = await explore(ctx, { mode: 'callers', target: 'gen11' })
    const diag = result.diagnostics as Array<{ code: string; message: string }>
    expect(diag.some((d) => d.code === 'file_count_stop' && d.message.includes('5'))).toBe(true)

    const ctx2 = activatedCtx(root(files), { max_files: 100 })
    const ok = await explore(ctx2, { mode: 'callers', target: 'gen11' })
    expect((ok.paths as unknown[]).length).toBeGreaterThan(0)

    function root(files: Record<string, string>): string {
      const r = fixtureProject(files)
      return r
    }
  })

  it('first-build timeout produces indexing status; project override works', async () => {
    const root = fixtureProject({ 'src/one.ts': 'export function one(): number { return 1 }\n' })
    const ctx = activatedCtx(root, { build_timeout_ms: 0 })
    const result = await explore(ctx, { mode: 'callers', target: 'one' })
    expect((result.metadata as { index: { status: string } }).index.status).toBe('indexing')

    const ctx2 = activatedCtx(root, { build_timeout_ms: 60_000 })
    const ok = await explore(ctx2, { mode: 'callers', target: 'one' })
    expect((ok.paths as unknown[]).length).toBeGreaterThan(0)
  })

  it('partial diagnostic present when any deviation occurred; absent on clean scan', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff])
    const messy = fixtureProject({
      'src/ok.ts': 'export function ok(): number { return 1 }\n',
      'src/skipme.bin.ts': binary,
    })
    const messyCtx = activatedCtx(messy)
    const messyResult = await explore(messyCtx, { mode: 'callers', target: 'ok' })
    expect((messyResult.diagnostics as Array<{ code: string }>).some((d) => d.code === 'partial')).toBe(true)

    const clean = fixtureProject({ 'src/clean.ts': 'export function clean(): number { return 2 }\n' })
    const cleanCtx = activatedCtx(clean)
    const cleanResult = await explore(cleanCtx, { mode: 'callers', target: 'clean' })
    expect((cleanResult.diagnostics as Array<{ code: string }>).some((d) => d.code === 'partial')).toBe(false)
  })

  it('exclude glob removes a directory; include glob adds an extension', async () => {
    const root = fixtureProject({
      'src/keep.ts': 'export function keep(): number { return 1 }\n',
      'generated/discard.ts': 'export function discard(): number { return 2 }\n',
    })
    const excluded = activatedCtx(root, { exclude: ['generated/'] })
    const exResult = await explore(excluded, { mode: 'callers', target: 'discard' })
    expect((exResult.paths as unknown[]).length).toBe(0)
    const kept = await explore(excluded, { mode: 'callers', target: 'keep' })
    expect((kept.paths as unknown[]).length).toBeGreaterThan(0)

    // include glob: admit a non-default extension that the extractor supports.
    const withVEnv = fixtureProject({
      'src/keep.ts': 'export function keep(): number { return 1 }\n',
      'scripts/tool.mjs': 'export function tool(): number { return 3 }\n',
    })
    const included = activatedCtx(withVEnv, { include: ['**/*.mjs'] })
    const inResult = await explore(included, { mode: 'callers', target: 'tool' })
    expect((inResult.paths as unknown[]).length).toBeGreaterThan(0)
  })

  it('diagnostic codes match the documented enumeration exactly', async () => {
    const { DIAGNOSTIC_CODES } = await import('../src/model.ts')
    const expected = new Set([
      'partial', 'unsupported_language', 'indexing', 'truncated', 'invalid_mode',
      'no_path', 'ambiguous_target', 'file_oversize', 'file_binary', 'file_decode_failed', 'file_count_stop',
    ])
    expect(DIAGNOSTIC_CODES.size).toBe(expected.size)
    for (const code of expected) {
      expect(DIAGNOSTIC_CODES.has(code as never)).toBe(true)
    }
  })
})
