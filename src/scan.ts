/**
 * Scan scope resolution (ADR-0003, ticket 7): walk the project root,
 * respect default exclusions + project globs, keep only supported-language
 * source files, enforce budgets, and report every deviation as a
 * diagnostic (never silent).
 */

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'
import { SUPPORTED_LANGUAGES, DEFAULT_EXCLUDED_DIRS } from './model.ts'
import type { DiagnosticCode } from './model.ts'

export interface ScanLimits {
  maxFileBytes: number
  maxFiles: number
  /** Globs to force-include (relative path prefixes or wildcard extension patterns). */
  include?: string[]
  /** Globs to force-exclude (relative path prefixes or wildcard extension patterns). */
  exclude?: string[]
}

/** Spec defaults (ADR-0003); project overrides may replace each value. */
export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFileBytes: 1_000_000,
  maxFiles: 50_000,
}

export interface ScanSkip {
  file: string
  code: DiagnosticCode
  message: string
}

export interface ScanOutcome {
  /** Project-relative paths (forward slashes) eligible for indexing. */
  files: string[]
  /** Files recognized as source but skipped, each with a diagnostic code. */
  skips: ScanSkip[]
  /** True when the file-count budget stopped the walk early. */
  stoppedEarly: boolean
}

/** Binary heuristic: NUL byte or replacement-heavy first 8 KB. */
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 8192))
  if (probe.includes(0)) return true
  let suspicious = 0
  for (const byte of probe) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
  }
  return suspicious / Math.max(1, probe.length) > 0.06
}

/** UTF-8 primary; BOM/common single-byte encodings auto-detected (spec). */
export function decodeSource(buf: Buffer): { text: string; encoding: string } | undefined {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: swap into LE.
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' }
  }
  const text = buf.toString('utf8')
  // Undecodable: the replacement character appears where bytes were invalid.
  if (text.includes('\ufffd')) return undefined
  return { text, encoding: 'utf8' }
}

interface GlobRule {
  raw: string
  kind: 'dir' | 'ext' | 'pattern'
  value: string
}

function parseGlobRule(raw: string): GlobRule {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  if (cleaned.startsWith('**/*.')) return { raw: cleaned, kind: 'ext', value: cleaned.slice(4).toLowerCase() }
  if (cleaned.includes('*')) return { raw: cleaned, kind: 'pattern', value: cleaned }
  return { raw: cleaned, kind: 'dir', value: cleaned.replace(/\/$/, '') }
}

function matchesRule(relForward: string, rule: GlobRule): boolean {
  if (rule.kind === 'dir') return relForward.startsWith(rule.value + '/') || relForward === rule.value
  if (rule.kind === 'ext') return relForward.toLowerCase().endsWith(rule.value)
  const re = new RegExp('^' + rule.value.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '(/.*)?$')
  return re.test(relForward) || relForward.split('/').some((part) => re.test(part))
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
 * Walk the project, honoring ignore rules, project globs, and budgets.
 * Every skip carries a diagnostic code; the store dir (.dsh/) stays
 * excluded by default per ADR-0003.
 */
export function scanProject(root: string, limits: ScanLimits = DEFAULT_SCAN_LIMITS): ScanOutcome {
  const ignored = parseGitignore(root)
  const includeRules = (limits.include ?? []).map(parseGlobRule)
  const excludeRules = (limits.exclude ?? []).map(parseGlobRule)
  const files: string[] = []
  const skips: ScanSkip[] = []
  let stoppedEarly = false

  const walk = (absDir: string, relDir: string): void => {
    if (files.length + skips.length >= limits.maxFiles) {
      stoppedEarly = true
      return
    }
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
      if (files.length + skips.length >= limits.maxFiles) {
        stoppedEarly = true
        return
      }
      const relForward = relative(root, abs).split(sep).join('/')
      if (excludeRules.some((r) => matchesRule(relForward, r))) continue
      const ext = extname(entry.name).toLowerCase()
      const supported = SUPPORTED_LANGUAGES.has(ext)
      const included = includeRules.some((r) => matchesRule(relForward, r))
      if (!supported && !included) continue
      let size: number
      try {
        size = statSync(abs).size
      } catch {
        continue
      }
      if (size > limits.maxFileBytes) {
        skips.push({ file: relForward, code: 'file_oversize', message: `${relForward} is ${size} bytes (cap ${limits.maxFileBytes})` })
        continue
      }
      let buf: Buffer
      try {
        buf = readFileSync(abs)
      } catch {
        continue
      }
      if (looksBinary(buf)) {
        skips.push({ file: relForward, code: 'file_binary', message: `${relForward} looks binary (NUL or control bytes)` })
        continue
      }
      const decoded = decodeSource(buf)
      if (decoded === undefined) {
        skips.push({ file: relForward, code: 'file_decode_failed', message: `${relForward} is not decodable as UTF-8 or a known BOM encoding` })
        continue
      }
      files.push(relForward)
    }
  }

  walk(root, '')
  return { files, skips, stoppedEarly }
}
