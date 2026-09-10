/**
 * Incremental refresh (ticket 5, ADR-0003): fingerprint-based change
 * detection + single-flight mutual exclusion per project. Queries wait
 * for one consistent snapshot; a refresh that exceeds its timeout
 * surfaces `indexing` status with progress, never a stale answer.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { scanProject, DEFAULT_SCAN_LIMITS } from './scan.ts'
import { relationsForFile } from './extract-ts.ts'
import type { RelationEdge } from './model.ts'
import { resolveCallConfidence } from './graph-internals.ts'

/** File fingerprint: mtimeMs + size. Change in either marks the file dirty. */
export interface FileFingerprint {
  mtimeMs: number
  size: number
}

export function fingerprintOf(absPath: string): FileFingerprint | undefined {
  try {
    const st = statSync(absPath)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return undefined
  }
}

export interface ChangeSet {
  /** Relative paths whose content changed since the snapshot. */
  changed: string[]
  /** Relative paths present in the snapshot but missing on disk. */
  deleted: string[]
}

/** Diff the current scan against a stored fingerprint map. */
export function detectChanges(projectRoot: string, previous: Record<string, FileFingerprint>): ChangeSet {
  const scan = scanProject(projectRoot, DEFAULT_SCAN_LIMITS)
  const changed: string[] = []
  const seen = new Set<string>()
  for (const rel of scan.files) {
    seen.add(rel)
    const fp = fingerprintOf(join(projectRoot, rel))
    const prev = previous[rel]
    if (fp === undefined || prev === undefined || fp.mtimeMs !== prev.mtimeMs || fp.size !== prev.size) {
      changed.push(rel)
    }
  }
  const deleted = Object.keys(previous).filter((rel) => !seen.has(rel))
  return { changed, deleted }
}

/**
 * Single-flight guard: one refresh at a time per ProjectGraph instance.
 * Concurrent callers wait on the same in-flight promise and receive the
 * same resulting snapshot (serialized, never interleaved).
 */
export class SingleFlight {
  private inFlight: Promise<void> | undefined

  run(work: () => Promise<void> | void): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = (async () => {
      try {
        await work()
      } finally {
        this.inFlight = undefined
      }
    })()
    return this.inFlight
  }
}

export interface RefreshOutcome {
  kind: 'incremental' | 'full'
  refreshedFiles: number
  fingerprints: Record<string, FileFingerprint>
  byFile: Record<string, RelationEdge[]>
}

/**
 * Incremental pass: re-extract only changed files, drop deleted ones,
 * keep untouched files' edges verbatim, then re-run the call-confidence
 * pass over the merged graph.
 */
export function incrementalRefresh(
  projectRoot: string,
  changes: ChangeSet,
  previous: { fingerprints: Record<string, FileFingerprint>; byFile: Record<string, RelationEdge[]> },
): RefreshOutcome {
  const byFile: Record<string, RelationEdge[]> = { ...previous.byFile }
  const fingerprints: Record<string, FileFingerprint> = { ...previous.fingerprints }
  for (const rel of changes.deleted) {
    delete byFile[rel]
    delete fingerprints[rel]
  }
  const fileSet = new Set(Object.keys(byFile).filter((k) => !changes.deleted.includes(k)).concat(changes.changed))
  let refreshed = 0
  for (const rel of changes.changed) {
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      try {
        byFile[rel] = relationsForFile(join(projectRoot, rel), rel, fileSet)
      } catch {
        byFile[rel] = []
      }
    }
    const fp = fingerprintOf(join(projectRoot, rel))
    if (fp !== undefined) fingerprints[rel] = fp
    refreshed++
  }
  resolveCallConfidence(byFile)
  return { kind: 'incremental', refreshedFiles: refreshed, fingerprints, byFile }
}
