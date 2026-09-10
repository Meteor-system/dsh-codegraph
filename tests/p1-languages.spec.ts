import { describe, expect, it } from 'vitest'
import { activate } from '../src/index.ts'
import type { FakeContext, CapturedRegistration } from '../src/contract.ts'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixtureProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-p1-'))
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
 * Hand-verified P1 fixtures (ticket 9 / #10).
 *
 * python  src/base.py
 *   Child(Base)          inherit exact  Child → Base
 *   make() -> Base       type-ref exact → Base
 *   Child().hi()         call exact     → hi
 *   self.greet()         call exact     → greet
 *
 * go      src/main.go
 *   Impl satisfies Speaker via Speak()   inherit inferred Impl → Speaker
 *   run(s Speaker)                       type-ref exact → Speaker
 *   s.Speak()                            call exact → Speak
 *
 * rust    src/lib.rs
 *   impl Speaker for Impl                inherit exact Impl → Speaker
 *   run(s: &dyn Speaker)                 type-ref exact → Speaker
 *   s.speak()                            call exact → speak
 *
 * java    src/Main.java
 *   Impl implements Speaker              inherit exact Impl → Speaker
 *   run(Speaker s)                       type-ref exact → Speaker
 *   s.speak()                            call exact → speak
 */
const FIXTURES: Record<string, Record<string, string>> = {
  python: {
    'src/base.py': 'class Base:\n    def greet(self):\n        return 1\n\nclass Child(Base):\n    def hi(self):\n        return self.greet()\n\ndef make() -> Base:\n    return Child()\n\ndef run() -> int:\n    return Child().hi()\n',
  },
  go: {
    'src/main.go': 'package src\n\ntype Speaker interface {\n\tSpeak() int\n}\n\ntype Impl struct{}\n\nfunc (i Impl) Speak() int { return 1 }\n\nfunc run(s Speaker) int {\n\treturn s.Speak()\n}\n',
  },
  rust: {
    'src/lib.rs': 'pub trait Speaker {\n    fn speak(&self) -> i32;\n}\n\npub struct Impl;\n\nimpl Speaker for Impl {\n    fn speak(&self) -> i32 { 1 }\n}\n\npub fn run(s: &dyn Speaker) -> i32 {\n    s.speak()\n}\n',
  },
  java: {
    'src/Main.java': 'public class Main {\n    interface Speaker {\n        int speak();\n    }\n    static class Impl implements Speaker {\n        public int speak() { return 1; }\n    }\n    static int run(Speaker s) {\n        return s.speak();\n    }\n}\n',
  },
}

const CALLER_TARGETS: Record<string, string> = { python: 'hi', go: 'Speak', rust: 'speak', java: 'speak' }
const TYPE_TARGETS: Record<string, string> = { python: 'Base', go: 'Speaker', rust: 'Speaker', java: 'Speaker' }
const IMPACT_TARGETS: Record<string, string> = { python: 'greet', go: 'Speak', rust: 'speak', java: 'speak' }
const INHERIT_CONFIDENCE: Record<string, 'exact' | 'inferred'> = {
  python: 'exact',
  go: 'inferred',
  rust: 'exact',
  java: 'exact',
}

describe('P1 languages (ticket 9)', () => {
  for (const [lang, files] of Object.entries(FIXTURES)) {
    it(`${lang}: indexes fixture and answers callers through the contract`, async () => {
      const ctx = activatedCtx(fixtureProject(files))
      const result = await explore(ctx, { mode: 'callers', target: CALLER_TARGETS[lang] })
      const edges = edgesOf(result)
      const calls = edges.filter((e) => e.kind === 'call')
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((e) => e.target === CALLER_TARGETS[lang])).toBe(true)
      expect(calls.every((e) => e.confidence === 'exact')).toBe(true)
      const sourceFile = Object.keys(files)[0].split('/').pop()!
      expect(edges.every((e) => e.location.file.endsWith(sourceFile))).toBe(true)
    }, 30_000)

    it(`${lang}: inheritance edges extract per language semantics`, async () => {
      const ctx = activatedCtx(fixtureProject(files))
      const result = await explore(ctx, { mode: 'callers', target: TYPE_TARGETS[lang], relation: 'inherit' })
      const edges = edgesOf(result).filter((e) => e.kind === 'inherit')
      expect(edges.length).toBeGreaterThan(0)
      expect(edges.every((e) => e.target === TYPE_TARGETS[lang])).toBe(true)
      expect(edges.every((e) => e.confidence === INHERIT_CONFIDENCE[lang])).toBe(true)
    }, 30_000)

    it(`${lang}: type references extract as type-ref edges`, async () => {
      const ctx = activatedCtx(fixtureProject(files))
      const result = await explore(ctx, { mode: 'callers', target: TYPE_TARGETS[lang], relation: 'type-ref' })
      const edges = edgesOf(result).filter((e) => e.kind === 'type-ref')
      expect(edges.length).toBeGreaterThan(0)
      expect(edges.every((e) => e.target === TYPE_TARGETS[lang])).toBe(true)
    }, 30_000)

    it(`${lang}: impact answers through the standard contract`, async () => {
      const ctx = activatedCtx(fixtureProject(files))
      const result = await explore(ctx, { mode: 'impact', target: IMPACT_TARGETS[lang] })
      const meta = result.metadata as { impact?: { direct: string[]; transitive: string[] } }
      expect(meta.impact).toBeDefined()
      expect(meta.impact!.direct.length + meta.impact!.transitive.length).toBeGreaterThan(0)
    }, 30_000)
  }

  it('capabilities metadata includes the four P1 languages', async () => {
    const ctx = activatedCtx(fixtureProject({ 'src/one.ts': 'export function one(): number { return 1 }\n' }))
    const result = await explore(ctx, { mode: 'callers', target: 'one' })
    const caps = (result.metadata as { capabilities: Record<string, { stage: string; precision: string }> }).capabilities
    for (const lang of ['python', 'go', 'rust', 'java']) {
      expect(caps[lang]).toEqual({ stage: 'P1', precision: 'syntax+inferred' })
    }
  })

  it('python: relative import resolves to the defining module', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/base.py': 'class Base:\n    def greet(self):\n        return 1\n',
      'src/app.py': 'from .base import Base\ndef run() -> Base:\n    return Base()\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'base.py', relation: 'import' })
    const imports = edgesOf(result).filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/app.py') && e.target.endsWith('src/base.py'))).toBe(true)
    expect(imports.every((e) => e.confidence === 'exact')).toBe(true)
  }, 30_000)

  it('go: import path resolves to the defining module', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/speak.go': 'package speak\n\ntype Speaker interface {\n\tSpeak() int\n}\n',
      'src/main.go': 'package src\n\nimport "speak"\n\nfunc run() int { return 1 }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'speak.go', relation: 'import' })
    const imports = edgesOf(result).filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/main.go') && e.target.endsWith('src/speak.go'))).toBe(true)
  }, 30_000)

  it('rust: mod declaration resolves to the defining module', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/speak.rs': 'pub struct Impl;\n',
      'src/lib.rs': 'mod speak;\npub fn run() -> i32 { 1 }\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'speak.rs', relation: 'import' })
    const imports = edgesOf(result).filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/lib.rs') && e.target.endsWith('src/speak.rs'))).toBe(true)
  }, 30_000)

  it('java: import declaration resolves to the defining type file', async () => {
    const ctx = activatedCtx(fixtureProject({
      'src/Speak.java': 'public class Speak {}\n',
      'src/Main.java': 'import Speak;\npublic class Main {\n    static int run() { return 1; }\n}\n',
    }))
    const result = await explore(ctx, { mode: 'callers', target: 'Speak.java', relation: 'import' })
    const imports = edgesOf(result).filter((e) => e.kind === 'import')
    expect(imports.some((e) => e.source.endsWith('src/Main.java') && e.target.endsWith('src/Speak.java'))).toBe(true)
  }, 30_000)
})
