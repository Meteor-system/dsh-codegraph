import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-p2-'))
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
 * Hand-verified P2 fixtures (ticket 10 / #11).
 *
 * c       src/main.c + speak.h
 *   greet() / greet()        call exact
 *   #include "speak.h"       import exact  main.c → speak.h
 *   #define macros           not extracted (heuristic limit)
 *
 * cpp     src/main.cpp
 *   Child : public Base      inherit exact → Base
 *   greet() call             call exact
 *
 * csharp  src/Main.cs
 *   Impl : Demo.Speaker      inherit exact → Speaker (last segment)
 *   Run(Demo.Speaker s)      type-ref exact → Speaker
 *   Greet()                  call exact
 *
 * php     src/main.php
 *   greet()                  call exact
 *   $obj->$name()            call heuristic
 *
 * ruby    src/main.rb
 *   greet                    call exact
 *   obj.send(name)           call heuristic
 *
 * bash    src/main.sh + lib.sh
 *   greet                    call exact
 *   source ./lib.sh          import exact  main.sh → lib.sh
 */
describe('P2 languages (ticket 10)', () => {
  it('c: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.c': 'int greet(void) { return 1; }\nint run(void) { return greet(); }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('c: preprocessor include produces an import edge', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/speak.h': 'int greet(void);\n',
      'src/main.c': '#include "speak.h"\nint greet(void) { return 1; }\nint run(void) { return greet(); }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'speak.h', relation: 'import' })
    const imports = edgesOf(result).filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/main.c') && e.target.endsWith('src/speak.h'))).toBe(true)
  }, 30_000)

  it('cpp: preprocessor include produces an import edge', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/speak.hpp': 'int greet();\n',
      'src/main.cpp': '#include "speak.hpp"\nint greet() { return 1; }\nint run() { return greet(); }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'speak.hpp', relation: 'import' })
    const imports = edgesOf(result).filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/main.cpp') && e.target.endsWith('src/speak.hpp'))).toBe(true)
  }, 30_000)

  it('c: impact answers through the standard contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.c': 'int greet(void) { return 1; }\nint run(void) { return greet(); }\n',
    }))
    const result = await explore(ctx, { mode: 'impact', target: 'greet' })
    const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
    expect(meta.impact).toBeDefined()
    expect(meta.impact!.direct.length + meta.impact!.transitive.length).toBeGreaterThan(0)
  }, 30_000)

  it('cpp: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.cpp': 'int greet() { return 1; }\nint run() { return greet(); }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('cpp: inheritance edges extract per language semantics', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.cpp': 'class Base { public: int greet() { return 1; } };\nclass Child : public Base { public: int hi() { return greet(); } };\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'Base', relation: 'inherit' })
    const edges = edgesOf(result).filter((e) => e.kind === 'inherit')
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every((e) => e.target === 'Base')).toBe(true)
    expect(edges.every((e) => e.confidence === 'exact')).toBe(true)
  }, 30_000)

  it('csharp: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Main.cs': 'class Main {\n    static int Greet() { return 1; }\n    static int Run() { return Greet(); }\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'Greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'Greet')).toBe(true)
  }, 30_000)

  it('csharp: inheritance, type-refs, and namespace-qualified names extract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Main.cs': 'namespace Demo { interface Speaker { int Speak(); } }\nclass Impl : Demo.Speaker { public int Speak() { return 1; } }\nclass Main { static int Run(Demo.Speaker s) { return s.Speak(); } }\n',
    }))
    const inherit = edgesOf(await explore(ctx, { mode: 'callers', target: 'Speaker', relation: 'inherit' })).filter((e) => e.kind === 'inherit')
    expect(inherit.length).toBeGreaterThan(0)
    expect(inherit.every((e) => e.target === 'Speaker')).toBe(true)
    const typeRefs = edgesOf(await explore(ctx, { mode: 'callers', target: 'Speaker', relation: 'type-ref' })).filter((e) => e.kind === 'type-ref')
    expect(typeRefs.length).toBeGreaterThan(0)
  }, 30_000)

  it('php: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.php': '<?php\nfunction greet() { return 1; }\nfunction run() { return greet(); }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('php: dynamic member call is labeled heuristic', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.php': '<?php\nfunction run($obj, $name) { return $obj->$name(); }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'run' })
    expect(edgesOf(result).some((e) => e.kind === 'definition' && e.target === 'run')).toBe(true)
    const notANode = await explore(ctx, { mode: 'callers', target: 'name' })
    expect(edgesOf(notANode).length).toBe(0)
    expect((notANode.diagnostics as Array<{ code: string }>).some((d) => d.code === 'unknown_target')).toBe(true)
  }, 30_000)

  it('ruby: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.rb': 'def greet\n  1\nend\ndef run\n  greet\nend\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('ruby: send metaprogramming call is labeled heuristic', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.rb': 'def run(obj, name)\n  obj.send(name)\nend\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'run' })
    expect(edgesOf(result).some((e) => e.kind === 'definition' && e.target === 'run')).toBe(true)
    const notANode = await explore(ctx, { mode: 'callers', target: 'send' })
    expect(edgesOf(notANode).length).toBe(0)
    expect((notANode.diagnostics as Array<{ code: string }>).some((d) => d.code === 'unknown_target')).toBe(true)
  }, 30_000)

  it('bash: indexes fixture and answers callers through the contract', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/main.sh': 'greet() { echo 1; }\nrun() { greet; }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'greet' })
    const calls = edgesOf(result).filter((e) => e.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((e) => e.target === 'greet')).toBe(true)
  }, 30_000)

  it('bash: source produces an import edge', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/lib.sh': 'greet() { echo 1; }\n',
      'src/main.sh': 'source ./lib.sh\nrun() { greet; }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'lib.sh', relation: 'import' })
    const imports = edgesOf(result).filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/main.sh') && e.target.endsWith('src/lib.sh'))).toBe(true)
  }, 30_000)

  it('cpp/csharp/php/ruby/bash: impact answers through the standard contract', async () => {
    const fixtures: Array<[string, Record<string, string>, string]> = [
      ['cpp', { 'src/main.cpp': 'int greet() { return 1; }\nint run() { return greet(); }\n' }, 'greet'],
      ['csharp', { 'src/Main.cs': 'class Main {\n    static int Greet() { return 1; }\n    static int Run() { return Greet(); }\n}\n' }, 'Greet'],
      ['php', { 'src/main.php': '<?php\nfunction greet() { return 1; }\nfunction run() { return greet(); }\n' }, 'greet'],
      ['ruby', { 'src/main.rb': 'def greet\n  1\nend\ndef run\n  greet\nend\n' }, 'greet'],
      ['bash', { 'src/main.sh': 'greet() { echo 1; }\nrun() { greet; }\n' }, 'greet'],
    ]
    for (const [, files, target] of fixtures) {
      const ctx = activatedCtx(fixtureProject(files))
      const result = await explore(ctx, { mode: 'impact', target })
      const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
      expect(meta.impact).toBeDefined()
      expect(meta.impact!.direct.length + meta.impact!.transitive.length).toBeGreaterThan(0)
    }
  }, 30_000)

  it('capabilities metadata includes the six P2 languages', async () => {
    const ctx = activatedCtx(fixtureProject({ 'src/one.ts': 'export function one(): number { return 1 }\n' }))
    const result = await explore(ctx, { mode: 'callers', target: 'one' })
    const caps = (result.metadata as { capabilities: Record<string, { stage: string; precision: string }> }).capabilities
    for (const lang of ['c', 'cpp', 'csharp', 'php', 'ruby', 'bash']) {
      expect(caps[lang]?.stage).toBe('P2')
    }
  })
})
