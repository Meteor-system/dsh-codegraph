/**
 * Snapshot store (ADR-0003): the schema-versioned on-disk graph cache at
 * <project>/.dsh/codegraph/. A version mismatch forces a full rebuild.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SNAPSHOT_SCHEMA_VERSION } from './model.ts'
import type { RelationEdge } from './model.ts'

export interface Snapshot {
  schemaVersion: number
  /** Edges grouped by file for cheap incremental refresh later. */
  byFile: Record<string, RelationEdge[]>
  /** Hash of the scan-shape settings the snapshot was built with. */
  scanShapeHash?: string
}

export function storeDirOf(projectRoot: string): string {
  return join(projectRoot, '.dsh', 'codegraph')
}

export function loadSnapshot(projectRoot: string): Snapshot | undefined {
  const path = join(storeDirOf(projectRoot), 'snapshot.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Snapshot
    if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function saveSnapshot(projectRoot: string, snapshot: Snapshot): void {
  const dir = storeDirOf(projectRoot)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snapshot))
}
