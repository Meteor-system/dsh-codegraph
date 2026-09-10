/**
 * Package boundary detection (ticket 8): within the one project-root
 * graph, packages are directories containing a package.json whose name
 * is known, discovered under conventional roots plus the workspace root
 * itself.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface PackageInfo {
  /** Package directory relative to the project root, forward slashes. */
  dir: string
  /** The package.json name, when present. */
  name?: string
}

/** Conventional monorepo package roots, checked in order. */
const PACKAGE_ROOTS = ['packages', 'libs', 'apps', 'pkg']

/** Discover packages: workspace-root package.json + sub-package dirs. */
export function discoverPackages(projectRoot: string): PackageInfo[] {
  const packages: PackageInfo[] = []

  // The workspace root itself can be a package (single-package repos).
  const rootManifest = join(projectRoot, 'package.json')
  if (existsSync(rootManifest)) {
    packages.push({ dir: '', name: readName(rootManifest) })
  }

  for (const base of PACKAGE_ROOTS) {
    const baseDir = join(projectRoot, base)
    if (!existsSync(baseDir)) continue
    let entries
    try {
      entries = readdirSafe(baseDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      // One level of nesting (scopes like @repo live in the package name,
      // not the directory layout, for our purposes).
      const pkgDir = join(baseDir, entry)
      const manifest = join(pkgDir, 'package.json')
      if (existsSync(manifest)) {
        packages.push({ dir: `${base}/${entry}`, name: readName(manifest) })
        continue
      }
      // Two-level nesting (e.g. packages/@scope/name).
      for (const sub of readdirSafe(pkgDir)) {
        const subManifest = join(pkgDir, sub, 'package.json')
        if (existsSync(subManifest)) {
          packages.push({ dir: `${base}/${entry}/${sub}`, name: readName(subManifest) })
        }
      }
    }
  }
  return packages
}

function readName(manifestPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
    return parsed.name
  } catch {
    return undefined
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Map a file path to its package dir (longest prefix wins). */
export function packageOf(relPath: string, packages: PackageInfo[]): PackageInfo | undefined {
  const rel = relPath.split('\\').join('/')
  let best: PackageInfo | undefined
  for (const pkg of packages) {
    if (pkg.dir === '' ) continue
    if (rel.startsWith(pkg.dir + '/') && (best === undefined || pkg.dir.length > best.dir.length)) {
      best = pkg
    }
  }
  return best
}

/**
 * Resolve a monorepo-style import specifier (`@scope/name/sub/path` or
 * `name/sub/path`) to a file inside the discovered packages. Returns
 * undefined for anything the package map can't satisfy.
 */
export function resolvePackageImport(specifier: string, packages: PackageInfo[], projectFiles: ReadonlySet<string>): string | undefined {
  const parts = specifier.split('/')
  let pkgName: string
  let rest: string[]
  if (specifier.startsWith('@')) {
    if (parts.length < 2) return undefined
    pkgName = parts.slice(0, 2).join('/')
    rest = parts.slice(2)
  } else {
    pkgName = parts[0]
    rest = parts.slice(1)
  }
  const pkg = packages.find((p) => p.name === pkgName)
  if (pkg === undefined || pkg.dir === '') return undefined
  const base = [pkg.dir, ...rest].join('/')
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map((ext) => base + ext)]
  return candidates.find((c) => projectFiles.has(c))
}
