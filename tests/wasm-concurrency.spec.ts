import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relationsForWasmFile } from '../src/extract-wasm.ts'

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-wasm-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

const PY = 'def foo():\n    return 1\n\nclass Bar:\n    def baz(self):\n        foo()\n'

describe('wasm parser concurrency', () => {
  it('two overlapping parses of different files do not throw', async () => {
    const root = fixture({
      'a.py': PY.repeat(50),
      'b.py': PY.repeat(50),
      'c.py': PY.repeat(50),
      'd.py': PY.repeat(50),
    })
    const files = ['a.py', 'b.py', 'c.py', 'd.py']
    const projectFiles = new Set(files)
    const results = await Promise.all(
      files.map((rel) => relationsForWasmFile(join(root, rel), rel, projectFiles)),
    )
    for (const rels of results) {
      expect(rels.some((r) => r.target === 'foo')).toBe(true)
    }
  })
})
