/**
 * Scan scope resolution (ADR-0003): walk the project root, respect
 * default exclusions, keep only supported-language source files.
 */

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'
import { SUPPORTED_LANGUAGES, DEFAULT_EXCLUDED_DIRS } from './model.ts'

export interface ScanLimits {
  maxFileBytes: number
  maxFiles: number
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFileBytes: 1_000_000,
  maxFiles: 50_000,
}

export interface ScanOutcome {
  /** Project-relative paths (forward slashes) eligible for indexing. */
  files: string[]
  /** Files recognized as supported but skipped, with reasons. */
  skips: Array<{ file: string; reason: 'oversize' }>
}

/** .gitignore in its minimal form: one pattern per line, `#` comments. */
function parseGitignore(root: string): Array<(rel: string) => boolean> {
  const gitignorePath = join(root, '.gitignore')
  if (!existsSync(gitignorePath)) return []
  const rules: Array<(rel: string) => boolean> = []
  for (const raw of readFileSync(gitignorePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.includes('*')) {
      const re = new RegExp('^' + line.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '(/.*)?$')
      rules.push((rel) => re.test(rel) || rel.split('/').some((part) => re.test(part)))
    } else {
      const name = line.replace(/\\/g, '/').replace(/\/$/, '')
      rules.push((rel) => rel === name || rel.startsWith(name + '/') || rel.split('/').includes(name.split('/').pop()!))
    }
  }
  return rules
}

function isExcluded(relDir: string, ignored: Array<(rel: string) => boolean>): boolean {
  const parts = relDir.split(sep).filter(Boolean)
  if (parts.some((p) => DEFAULT_EXCLUDED_DIRS.has(p))) return true
  const relForward = parts.join('/')
  return ignored.some((match) => match(relForward))
}

/**
 * Walk the project, honoring ignore rules. Directories named by the
 * default exclusions or the project's .gitignore never descend; the
 * snapshot store (.dsh/) is excluded by default per ADR-0003.
 */
export function scanProject(root: string, limits: ScanLimits = DEFAULT_SCAN_LIMITS): ScanOutcome {
  const ignored = parseGitignore(root)
  const files: string[] = []
  const skips: ScanOutcome['skips'] = []

  const walk = (absDir: string, relDir: string): void => {
    if (files.length + skips.length >= limits.maxFiles) return
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(absDir, entry.name)
      const rel = relDir === '' ? entry.name : relDir + sep + entry.name
      if (entry.isDirectory()) {
        if (!isExcluded(rel, ignored)) walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      if (isExcluded(rel, ignored)) continue
      if (!SUPPORTED_LANGUAGES.has(extname(entry.name).toLowerCase())) continue
      if (files.length + skips.length >= limits.maxFiles) return
      let size: number
      try {
        size = statSync(abs).size
      } catch {
        continue
      }
      const relForward = relative(root, abs).split(sep).join('/')
      if (size > limits.maxFileBytes) {
        skips.push({ file: relForward, reason: 'oversize' })
        continue
      }
      files.push(relForward)
    }
  }

  walk(root, '')
  return { files, skips }
}
