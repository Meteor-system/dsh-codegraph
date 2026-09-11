import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const root = join(import.meta.dirname, '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

describe('packaging (ticket 12)', () => {
  it('provenance lists every grammar dependency with package, version, and license', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    const provenance = JSON.parse(read('grammars/provenance.json')) as {
      runtime: { package: string; version: string; license: string }
      grammars: Array<{ package: string; version: string; license: string; wasm: string }>
      razor: { source: string; license: string; wasm: string; commit: string | null }
    }
    const grammarDeps = Object.keys(pkg.dependencies).filter((n) => n.startsWith('tree-sitter-'))
    expect(pkg.dependencies['web-tree-sitter']).toBe(provenance.runtime.version)
    expect(provenance.runtime.license).toBe('MIT')
    for (const name of grammarDeps) {
      const ver = pkg.dependencies[name]
      expect(ver, `${name} must be an exact pin`).not.toMatch(/^[~^]/)
      const row = provenance.grammars.find((g) => g.package === name)
      expect(row, name).toBeDefined()
      expect(row!.version).toBe(ver)
      expect(row!.license).toBe('MIT')
      expect(row!.wasm.length).toBeGreaterThan(0)
    }
    expect(provenance.razor.source).toContain('tree-sitter-razor')
    expect(provenance.razor.license).toBe('MIT')
  })

  it('README covers install, enablement, configuration, diagnostics, and limitations', () => {
    const readme = read('README.md').toLowerCase()
    for (const term of ['profile', 'enable', 'max_files', 'max_file_bytes', '.dsh/codegraph', 'diagnostic', 'limitation']) {
      expect(readme, term).toContain(term)
    }
  })

  it('release checklist documents schema-version rebuilds and grammar upgrades', () => {
    const text = read('docs/release-checklist.md').toLowerCase()
    expect(text).toContain('schema')
    expect(text).toContain('rebuild')
    expect(text).toContain('grammar')
  })

  it('each grammar wasm ABI is within web-tree-sitter support', async () => {
    const { createRequire } = await import('node:module')
    const nodeRequire = createRequire(import.meta.url)
    const mod = await import('web-tree-sitter') as unknown as {
      Parser: { init: (opts?: { locateFile?: (name: string) => string }) => Promise<void> }
      Language: { load: (p: string) => Promise<{ abiVersion: number }> }
    }
    const { Parser, Language } = mod
    await Parser.init({
      locateFile(scriptName: string) {
        if (scriptName.endsWith('.wasm')) return nodeRequire.resolve('web-tree-sitter/web-tree-sitter.wasm')
        return scriptName
      },
    })
    const provenance = JSON.parse(read('grammars/provenance.json')) as {
      grammars: Array<{ package: string; wasm: string }>
    }
    for (const g of provenance.grammars) {
      const pkgRoot = nodeRequire.resolve(`${g.package}/package.json`)
      const wasmPath = join(pkgRoot, '..', g.wasm)
      // Language.load throws if the grammar ABI is outside web-tree-sitter's range.
      const lang = await Language.load(wasmPath)
      expect(lang.abiVersion, g.package).toBeGreaterThan(0)
    }
  }, 60_000)

  it('npm pack dry-run includes the publishable artifact', () => {
    const raw = execSync('npm pack --dry-run --ignore-scripts --json', { cwd: root, encoding: 'utf8' })
    const parsed = JSON.parse(raw) as Array<{ filename: string; files: Array<{ path: string }> }> | { files: Array<{ path: string }> }
    const files = (Array.isArray(parsed) ? parsed[0].files : parsed.files).map((f) => f.path.replace(/\\/g, '/'))
    expect(files.some((p) => p === 'package.json' || p.endsWith('/package.json'))).toBe(true)
    expect(files.some((p) => p.includes('cordis.patch.yml'))).toBe(true)
    expect(files.some((p) => p.includes('grammars/provenance.json'))).toBe(true)
    expect(files.some((p) => p.includes('README.md'))).toBe(true)
  }, 30_000)
})
