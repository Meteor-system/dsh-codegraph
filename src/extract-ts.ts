/**
 * TS-family extraction adapter (ADR-0005): typescript@5.9.3, pinned.
 * Syntax-level only — no type checker. Produces definition edges (from
 * function/class/interface/type declarations and exported consts) and
 * import edges (import declarations, resolved to local files by
 * export matching).
 */

import * as ts from 'typescript'
import { readFileSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import type { RelationEdge, RelationKind, Confidence } from './model.ts'

export function scriptKindOf(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Symbols this file declares, with their kind and position. */
export interface ExtractedSymbol {
  name: string
  kind: RelationKind
  line: number
  col: number
}

export interface ExtractedFile {
  symbols: ExtractedSymbol[]
  imports: Array<{ specifier: string; line: number; col: number }>
}

export function extractTsFamily(absPath: string, relPath: string): ExtractedFile {
  const text = readFileSync(absPath, 'utf8')
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.ES2022, true, scriptKindOf(relPath))
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedFile['imports'] = []

  const lineOf = (node: ts.Node): { line: number; col: number } => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    return { line: pos.line + 1, col: pos.character + 1 }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const at = lineOf(node)
      symbols.push({ name: node.name.text, kind: 'definition', line: at.line, col: at.col })
    } else if (ts.isClassDeclaration(node) && node.name) {
      const at = lineOf(node)
      symbols.push({ name: node.name.text, kind: 'definition', line: at.line, col: at.col })
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      const at = lineOf(node)
      symbols.push({ name: node.name.text, kind: 'definition', line: at.line, col: at.col })
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      const at = lineOf(node)
      symbols.push({ name: node.name.text, kind: 'definition', line: at.line, col: at.col })
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && (decl.initializer !== undefined || (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword))) {
          const at = lineOf(decl)
          symbols.push({ name: decl.name.text, kind: 'definition', line: at.line, col: at.col })
        }
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const at = lineOf(node)
      imports.push({ specifier: node.moduleSpecifier.text, line: at.line, col: at.col })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const at = lineOf(node)
      imports.push({ specifier: node.moduleSpecifier.text, line: at.line, col: at.col })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)

  return { symbols, imports }
}

/**
 * Resolve a relative import specifier to a project file, trying the
 * extension ladder; returns undefined for package imports (bare
 * specifiers) — those are real dependency edges but resolve per-package
 * in the monorepo ticket.
 */
export function resolveLocalImport(fromRelFile: string, specifier: string, projectFiles: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.normalize(posix.join(posix.dirname(fromRelFile.split('\\').join('/')), specifier))
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map((ext) => base + ext)]
  return candidates.find((c) => projectFiles.has(c))
}

export interface ExtractedRelation {
  kind: RelationKind
  source: string
  target: string
  confidence: Confidence
  location: { file: string; line: number; col: number }
}

/** Extract definition + import relations for one file. */
export function relationsForFile(absPath: string, relPath: string, projectFiles: ReadonlySet<string>): ExtractedRelation[] {
  const extracted = extractTsFamily(absPath, relPath)
  const relations: ExtractedRelation[] = extracted.symbols.map((s) => ({
    kind: s.kind,
    source: relPath,
    target: s.name,
    confidence: 'exact' as const,
    location: { file: relPath, line: s.line, col: s.col },
  }))
  for (const imp of extracted.imports) {
    const resolved = resolveLocalImport(relPath, imp.specifier, projectFiles)
    if (resolved !== undefined) {
      relations.push({
        kind: 'import',
        source: relPath,
        target: resolved,
        confidence: 'exact',
        location: { file: relPath, line: imp.line, col: imp.col },
      })
    }
  }
  return relations
}
