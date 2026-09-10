/**
 * tree-sitter WASM extraction adapter (ADR-0001): P1 + P2 languages.
 * Grammar WASMs ship in the official npm packages; web-tree-sitter loads
 * them in plain Node. Extraction walks the concrete syntax tree with
 * per-language rules and emits the same relation model as the TS adapter.
 */

import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { createRequire } from 'node:module'
import type { PackageInfo } from './packages.ts'
import { resolvePackageImport } from './packages.ts'
import type { ExtractedRelation, ExtractedSymbol } from './extract-ts.ts'

const nodeRequire = createRequire(import.meta.url)

// Lazy singleton loader: Parser.init() once, then one Language per grammar.
let parserPromise: Promise<{ parser: { parse: (s: string) => unknown; setLanguage: (l: unknown) => void }; load: (pkg: string, wasmFile: string) => Promise<unknown> }> | undefined
const languageCache = new Map<string, Promise<unknown>>()

interface TSNode {
  type: string
  text: string
  startIndex: number
  endIndex: number
  childCount: number
  child(i: number): TSNode | null
  children: TSNode[]
  startPosition: { row: number; column: number }
  parent?: TSNode
}

async function getParser(): Promise<{ parser: { parse: (s: string) => unknown; setLanguage: (l: unknown) => void }; load: (pkg: string, wasmFile: string) => Promise<unknown> }> {
  if (parserPromise === undefined) {
    parserPromise = (async () => {
      const mod = (await import('web-tree-sitter')) as unknown as {
        Parser: { init: (opts?: { locateFile?: (name: string) => string }) => Promise<void>; new (): unknown }
        Language: { load: (p: string) => Promise<unknown> }
      }
      await mod.Parser.init({
        locateFile(scriptName: string) {
          if (scriptName.endsWith('.wasm')) return nodeRequire.resolve('web-tree-sitter/web-tree-sitter.wasm')
          return scriptName
        },
      })
      const parser = new mod.Parser() as unknown as { parse: (s: string) => unknown; setLanguage: (l: unknown) => void }
      const load = (pkg: string, wasmFile: string): Promise<unknown> => {
        let cached = languageCache.get(pkg)
        if (cached === undefined) {
          const pkgRoot = nodeRequire.resolve(`${pkg}/package.json`)
          const wasmPath = join(pkgRoot, '..', wasmFile)
          cached = mod.Language.load(wasmPath)
          languageCache.set(pkg, cached)
        }
        return cached
      }
      return { parser, load }
    })()
  }
  return parserPromise
}

/** Language registry: extension → npm grammar package (+ wasm filename when it differs). */
const WASM_LANGUAGES: Record<string, { pkg: string; ext: string; wasm?: string }> = {
  '.py': { pkg: 'tree-sitter-python', ext: 'python' },
  '.go': { pkg: 'tree-sitter-go', ext: 'go' },
  '.rs': { pkg: 'tree-sitter-rust', ext: 'rust' },
  '.java': { pkg: 'tree-sitter-java', ext: 'java' },
  '.c': { pkg: 'tree-sitter-c', ext: 'c' },
  '.h': { pkg: 'tree-sitter-c', ext: 'c' },
  '.cpp': { pkg: 'tree-sitter-cpp', ext: 'cpp' },
  '.cc': { pkg: 'tree-sitter-cpp', ext: 'cpp' },
  '.hpp': { pkg: 'tree-sitter-cpp', ext: 'cpp' },
  '.cs': { pkg: 'tree-sitter-c-sharp', ext: 'csharp', wasm: 'tree-sitter-c_sharp.wasm' },
  '.php': { pkg: 'tree-sitter-php', ext: 'php' },
  '.rb': { pkg: 'tree-sitter-ruby', ext: 'ruby' },
  '.sh': { pkg: 'tree-sitter-bash', ext: 'bash' },
  '.bash': { pkg: 'tree-sitter-bash', ext: 'bash' },
}

export function isWasmLanguage(ext: string): boolean {
  return ext in WASM_LANGUAGES
}

function nodeText(node: TSNode): string {
  return node.text
}

function childAt(node: TSNode, i: number): TSNode | undefined {
  return node.child(i) ?? undefined
}

function childOfType(node: TSNode, type: string): TSNode | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const c = childAt(node, i)
    if (c !== undefined && c.type === type) return c
  }
  return undefined
}

function childOfTypeDeep(node: TSNode, type: string): TSNode | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const c = childAt(node, i)
    if (c === undefined) continue
    if (c.type === type) return c
    const deep = childOfTypeDeep(c, type)
    if (deep !== undefined) return deep
  }
  return undefined
}

/** Per-language symbol/call/type extraction over the concrete tree. */
interface LangExtraction {
  symbols: ExtractedSymbol[]
  imports: Array<{ specifier: string; line: number; col: number }>
  calls: Array<{ callee: string; line: number; col: number }>
  inherits: Array<{ child: string; parent: string; line: number; col: number; confidence: 'exact' | 'inferred' }>
  typeRefs: Array<{ name: string; line: number; col: number }>
}

function emptyExtraction(): LangExtraction {
  return { symbols: [], imports: [], calls: [], inherits: [], typeRefs: [] }
}

function pos(node: TSNode): { line: number; col: number } {
  return { line: node.startPosition.row + 1, col: node.startPosition.column + 1 }
}

/** Python: def/class definitions, calls, base-class inheritance, annotations. */
function extractPython(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'function_definition') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'class_definition') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) {
        out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
        const args = childOfType(node, 'argument_list')
        if (args !== undefined) {
          for (let i = 0; i < args.childCount; i++) {
            const base = childAt(args, i)
            if (base !== undefined && (base.type === 'identifier' || base.type === 'attribute')) {
              out.inherits.push({ child: nodeText(name), parent: nodeText(base), line: at.line, col: at.col, confidence: 'exact' })
            }
          }
        }
      }
    } else if (node.type === 'call') {
      const fn = childAt(node, 0)
      if (fn !== undefined && (fn.type === 'identifier' || fn.type === 'attribute')) {
        const text = nodeText(fn)
        out.calls.push({ callee: text.includes('.') ? text.split('.').pop()! : text, line: at.line, col: at.col })
      }
    } else if (node.type === 'type') {
      const inner = node.childCount > 0 ? childAt(node, 0) : node
      if (inner !== undefined && inner.type === 'identifier') {
        out.typeRefs.push({ name: nodeText(inner), line: at.line, col: at.col })
      }
    } else if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      const module = childOfType(node, 'relative_import') ?? childOfType(node, 'dotted_name')
      if (module !== undefined) out.imports.push({ specifier: nodeText(module), line: at.line, col: at.col })
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

/** Go: func/type/interface definitions, method sets, embedded interfaces, calls. */
function extractGo(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const interfaceMethods = new Map<string, Set<string>>() // interface name -> method names
  const structMethods = new Map<string, { methods: Set<string>; line: number; col: number }>()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'function_declaration') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'method_declaration') {
      const name = childOfType(node, 'field_identifier')
      const receiver = childOfTypeDeep(node, 'type_identifier')
      if (name !== undefined) {
        out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
        if (receiver !== undefined) {
          const recv = nodeText(receiver)
          if (!structMethods.has(recv)) structMethods.set(recv, { methods: new Set(), line: at.line, col: at.col })
          structMethods.get(recv)!.methods.add(nodeText(name))
        }
      }
    } else if (node.type === 'type_declaration') {
      const spec = childOfTypeDeep(node, 'type_spec')
      if (spec !== undefined) {
        const name = childOfType(spec, 'type_identifier')
        const body = spec.childCount > 0 ? childAt(spec, spec.childCount - 1) : undefined
        if (name !== undefined && body !== undefined) {
          out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
          if (body.type === 'interface_type') {
            const methods = new Set<string>()
            // Embedded interfaces: type_identifiers that are DIRECT
            // children of the interface body (method signatures nest
            // theirs inside method_elem nodes — never descend).
            for (let i = 0; i < body.childCount; i++) {
              const c = childAt(body, i)
              if (c === undefined) continue
              if (c.type === 'type_identifier') {
                out.inherits.push({ child: nodeText(name), parent: nodeText(c), line: at.line, col: at.col, confidence: 'exact' })
              } else if (c.type === 'method_elem' || c.type === 'method_spec' || c.type === 'method_element') {
                const m = childOfType(c, 'field_identifier')
                if (m !== undefined) methods.add(nodeText(m))
              }
            }
            interfaceMethods.set(nodeText(name), methods)
          }
        }
      }
    } else if (node.type === 'call_expression') {
      const fn = childAt(node, 0)
      if (fn !== undefined && fn.type === 'identifier') {
        out.calls.push({ callee: nodeText(fn), line: at.line, col: at.col })
      } else if (fn !== undefined && fn.type === 'selector_expression') {
        const field = childOfTypeDeep(fn, 'field_identifier')
        if (field !== undefined) out.calls.push({ callee: nodeText(field), line: at.line, col: at.col })
      }
    } else if (node.type === 'parameter_declaration' || node.type === 'parameter_type') {
      const ids: TSNode[] = []
      for (let i = 0; i < node.childCount; i++) {
        const c = childAt(node, i)
        if (c !== undefined && c.type === 'type_identifier') ids.push(c)
      }
      for (const id of ids) out.typeRefs.push({ name: nodeText(id), line: at.line, col: at.col })
    } else if (node.type === 'import_spec') {
      const pathNode = childOfType(node, 'interpreted_string_literal') ?? childOfType(node, 'raw_string_literal')
      if (pathNode !== undefined) {
        const raw = nodeText(pathNode)
        const spec = raw.length >= 2 ? raw.slice(1, -1) : raw
        out.imports.push({ specifier: spec, line: at.line, col: at.col })
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  // Implicit interface satisfaction: a concrete type whose method set
  // covers an interface's methods yields an inferred inherit edge
  // (Go has no explicit implements clause — ADR-0004 inferred semantics).
  for (const [iface, methods] of interfaceMethods) {
    if (methods.size === 0) continue
    for (const [type, have] of structMethods) {
      if (type === iface) continue
      let covered = true
      for (const m of methods) {
        if (!have.methods.has(m)) {
          covered = false
          break
        }
      }
      if (covered) out.inherits.push({ child: type, parent: iface, line: have.line, col: have.col, confidence: 'inferred' })
    }
  }
  return out
}

/** Rust: fn/trait/struct definitions, impl blocks, trait bounds, calls. */
function extractRust(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'function_item') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'trait_item') {
      const name = childOfType(node, 'type_identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'struct_item' || node.type === 'enum_item') {
      const name = childOfType(node, 'type_identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'impl_item') {
      // tree-sitter-rust: impl_item = [impl] <trait type_identifier> [for]
      // <self type_identifier> declaration_list. Collect identifiers
      // before the 'for' keyword: first = trait; after 'for' = the type.
      const before: string[] = []
      let after: string | undefined
      let seenFor = false
      for (let i = 0; i < node.childCount; i++) {
        const c = childAt(node, i)
        if (c === undefined) continue
        if (c.type === 'for') {
          seenFor = true
          continue
        }
        if (c.type === 'declaration_list') break
        if (c.type === 'type_identifier') {
          if (seenFor) after = nodeText(c)
          else before.push(nodeText(c))
        }
      }
      if (after !== undefined && before.length > 0) {
        out.inherits.push({ child: after, parent: before[0], line: at.line, col: at.col, confidence: 'exact' })
      }
    } else if (node.type === 'call_expression' || node.type === 'method_call_expression') {
      const fn = childAt(node, 0)
      if (fn !== undefined && fn.type === 'identifier') {
        out.calls.push({ callee: nodeText(fn), line: at.line, col: at.col })
      } else if (fn !== undefined && fn.type === 'field_expression') {
        const field = childOfTypeDeep(fn, 'field_identifier')
        if (field !== undefined) out.calls.push({ callee: nodeText(field), line: at.line, col: at.col })
      }
    } else if (node.type === 'generic_type' || node.type === 'dynamic_type' || node.type === 'reference_type' || node.type === 'pointer_type') {
      const ids: TSNode[] = []
      const collect = (n: TSNode): void => {
        for (let i = 0; i < n.childCount; i++) {
          const c = childAt(n, i)
          if (c === undefined) continue
          if (c.type === 'type_identifier') ids.push(c)
          collect(c)
        }
      }
      collect(node)
      for (const id of ids) out.typeRefs.push({ name: nodeText(id), line: at.line, col: at.col })
    } else if (node.type === 'mod_item') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) out.imports.push({ specifier: nodeText(name), line: at.line, col: at.col })
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

/** Java: class/interface/method definitions, extends/implements, calls, types. */
function extractJava(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
      const name = childOfTypeDeep(node, 'identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
      const superclass = childOfTypeDeep(node, 'superclass')
      if (superclass !== undefined) {
        const ids = childOfTypeDeep(superclass, 'type_identifier') ?? childOfTypeDeep(superclass, 'identifier')
        if (ids !== undefined && name !== undefined) {
          out.inherits.push({ child: nodeText(name), parent: nodeText(ids), line: at.line, col: at.col, confidence: 'exact' })
        }
      }
      // implements: node type is super_interfaces (the field is named "interfaces").
      for (let i = 0; i < node.childCount; i++) {
        const c = childAt(node, i)
        if (c !== undefined && (c.type === 'super_interfaces' || c.type === 'interfaces') && name !== undefined) {
          const collect = (n: TSNode): void => {
            for (let j = 0; j < n.childCount; j++) {
              const g = childAt(n, j)
              if (g === undefined) continue
              if (g.type === 'type_identifier' || g.type === 'identifier') {
                out.inherits.push({ child: nodeText(name), parent: nodeText(g), line: at.line, col: at.col, confidence: 'exact' })
              }
              collect(g)
            }
          }
          collect(c)
        }
      }
    } else if (node.type === 'method_declaration') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'method_invocation') {
      // tree-sitter-java: argument_list and the method-name identifier
      // are direct children; the receiver (if any) is an earlier child.
      // Pick the LAST direct identifier as the method name.
      let methodName: TSNode | undefined
      for (let i = 0; i < node.childCount; i++) {
        const c = childAt(node, i)
        if (c === undefined) continue
        if (c.type === 'identifier') methodName = c
        if (c.type === 'argument_list') break
      }
      if (methodName !== undefined) out.calls.push({ callee: nodeText(methodName), line: at.line, col: at.col })
    } else if (node.type === 'formal_parameter' || node.type === 'generic_type' || node.type === 'scoped_type_identifier') {
      const ids: TSNode[] = []
      const collect = (n: TSNode): void => {
        for (let i = 0; i < n.childCount; i++) {
          const c = childAt(n, i)
          if (c === undefined) continue
          if (c.type === 'type_identifier') ids.push(c)
          collect(c)
        }
      }
      collect(node)
      for (const id of ids) out.typeRefs.push({ name: nodeText(id), line: at.line, col: at.col })
    } else if (node.type === 'import_declaration') {
      const spec = nodeText(node).replace(/^import\s+/, '').replace(/;\s*$/, '').trim()
      if (spec.length > 0) out.imports.push({ specifier: spec, line: at.line, col: at.col })
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

/** C: function definitions, calls, #include paths. */
function extractC(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'function_definition') {
      const declarator = childOfTypeDeep(node, 'function_declarator')
      const name = declarator !== undefined ? childOfTypeDeep(declarator, 'identifier') : undefined
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'call_expression') {
      const fn = childAt(node, 0)
      if (fn !== undefined && fn.type === 'identifier') {
        out.calls.push({ callee: nodeText(fn), line: at.line, col: at.col })
      } else if (fn !== undefined && fn.type === 'field_expression') {
        const field = childOfTypeDeep(fn, 'field_identifier')
        if (field !== undefined) out.calls.push({ callee: nodeText(field), line: at.line, col: at.col })
      }
    } else if (node.type === 'preproc_include') {
      const pathNode = childOfType(node, 'string_literal') ?? childOfType(node, 'system_lib_string')
      if (pathNode !== undefined) {
        const raw = nodeText(pathNode).replace(/^["'<]/, '').replace(/[">']$/, '')
        if (raw.length > 0) out.imports.push({ specifier: raw, line: at.line, col: at.col })
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

/** C++: C extraction plus class/struct inheritance. */
function extractCpp(root: TSNode): LangExtraction {
  const out = extractC(root)
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
      const name = childOfType(node, 'type_identifier')
      if (name !== undefined) {
        out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
        const bases = childOfType(node, 'base_class_clause')
        if (bases !== undefined) {
          for (let i = 0; i < bases.childCount; i++) {
            const c = childAt(bases, i)
            if (c !== undefined && (c.type === 'type_identifier' || c.type === 'qualified_identifier')) {
              out.inherits.push({ child: nodeText(name), parent: nodeText(c), line: at.line, col: at.col, confidence: 'exact' })
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

const EXTRACTORS: Record<string, (root: TSNode) => LangExtraction> = {
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  java: extractJava,
  c: extractC,
  cpp: extractCpp,
  csharp: extractCsharp,
  php: extractPhp,
  ruby: extractRuby,
  bash: extractBash,
}

/** Bash: function definitions, command calls, source/. as imports. */
function extractBash(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'function_definition') {
      const name = childOfType(node, 'word')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'command') {
      const nameNode = childOfType(node, 'command_name')
      const cmd = nameNode !== undefined ? nodeText(nameNode) : ''
      if (cmd === 'source' || cmd === '.') {
        for (let i = 0; i < node.childCount; i++) {
          const c = childAt(node, i)
          if (c !== undefined && c.type === 'word' && c !== nameNode) {
            out.imports.push({ specifier: nodeText(c), line: at.line, col: at.col })
            break
          }
        }
      } else if (cmd.length > 0) {
        out.calls.push({ callee: cmd, line: at.line, col: at.col })
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

/** Ruby: methods/classes, calls (including bare identifiers), send/method_missing as unmatched. */
function extractRuby(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'method' || node.type === 'singleton_method') {
      const name = childOfType(node, 'identifier') ?? childOfTypeDeep(node, 'identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'class') {
      const name = childOfType(node, 'constant')
      if (name !== undefined) {
        out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
        const sup = childOfType(node, 'superclass')
        if (sup !== undefined) {
          const parent = childOfType(sup, 'constant') ?? childOfTypeDeep(sup, 'constant')
          if (parent !== undefined) {
            out.inherits.push({ child: nodeText(name), parent: nodeText(parent), line: at.line, col: at.col, confidence: 'exact' })
          }
        }
      }
    } else if (node.type === 'call') {
      const method = childOfType(node, 'identifier') ?? childOfTypeDeep(node, 'identifier')
      if (method !== undefined) out.calls.push({ callee: nodeText(method), line: at.line, col: at.col })
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  // Bare method calls (`greet` with no parens/receiver) are `identifier`
  // nodes, not `call`. Treat an identifier that isn't a definition name
  // occurrence at its own def as a call when it matches a known method
  // or stands alone in a body — emit every identifier that isn't the
  // name of an enclosing method node.
  const defined = new Set(out.symbols.map((s) => s.name))
  const visitId = (node: TSNode, inMethodName: boolean): void => {
    const at = pos(node)
    const thisIsMethod = node.type === 'method' || node.type === 'singleton_method'
    if (node.type === 'identifier' && !thisIsMethod) {
      const text = nodeText(node)
      if (!inMethodName && (defined.has(text) || text === 'send' || text === 'public_send' || text === 'method_missing')) {
        if (!out.calls.some((c) => c.callee === text && c.line === at.line && c.col === at.col)) {
          out.calls.push({ callee: text, line: at.line, col: at.col })
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visitId(c, thisIsMethod && i === 0)
    }
  }
  visitId(root, false)
  return out
}

/** PHP: functions/methods, calls; variable-method names stay unmatched → heuristic. */
function extractPhp(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'function_definition' || node.type === 'method_declaration') {
      const name = childOfType(node, 'name')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'class_declaration') {
      const name = childOfType(node, 'name')
      if (name !== undefined) {
        out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
        const bases = childOfType(node, 'base_clause')
        if (bases !== undefined) {
          for (let i = 0; i < bases.childCount; i++) {
            const c = childAt(bases, i)
            if (c !== undefined && c.type === 'name') {
              out.inherits.push({ child: nodeText(name), parent: nodeText(c), line: at.line, col: at.col, confidence: 'exact' })
            }
          }
        }
      }
    } else if (node.type === 'function_call_expression') {
      const fn = childOfType(node, 'name') ?? childAt(node, 0)
      if (fn !== undefined && fn.type === 'name') {
        out.calls.push({ callee: nodeText(fn), line: at.line, col: at.col })
      } else if (fn !== undefined && (fn.type === 'variable_name' || fn.type === 'dynamic_variable_name')) {
        out.calls.push({ callee: nodeText(fn).replace(/^\$/, ''), line: at.line, col: at.col })
      }
    } else if (node.type === 'member_call_expression') {
      let fromName: TSNode | undefined
      let fromVar: TSNode | undefined
      for (let i = 0; i < node.childCount; i++) {
        const c = childAt(node, i)
        if (c === undefined) continue
        if (c.type === 'name') fromName = c
        if (c.type === 'variable_name' || c.type === 'dynamic_variable_name') fromVar = c
      }
      if (fromName !== undefined) {
        out.calls.push({ callee: nodeText(fromName), line: at.line, col: at.col })
      } else if (fromVar !== undefined) {
        out.calls.push({ callee: nodeText(fromVar).replace(/^\$/, ''), line: at.line, col: at.col })
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

/** C#: classes/interfaces, base lists, invocations, parameter types. */
function extractCsharp(root: TSNode): LangExtraction {
  const out = emptyExtraction()
  const visit = (node: TSNode): void => {
    const at = pos(node)
    if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'struct_declaration') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) {
        out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
        const bases = childOfType(node, 'base_list')
        if (bases !== undefined) {
          for (let i = 0; i < bases.childCount; i++) {
            const c = childAt(bases, i)
            if (c === undefined) continue
            if (c.type === 'identifier' || c.type === 'qualified_name') {
              const parent = c.type === 'qualified_name' ? (nodeText(c).split('.').pop() ?? nodeText(c)) : nodeText(c)
              out.inherits.push({ child: nodeText(name), parent, line: at.line, col: at.col, confidence: 'exact' })
              out.typeRefs.push({ name: parent, line: at.line, col: at.col })
            }
          }
        }
      }
    } else if (node.type === 'method_declaration') {
      const name = childOfType(node, 'identifier')
      if (name !== undefined) out.symbols.push({ name: nodeText(name), kind: 'definition', line: at.line, col: at.col })
    } else if (node.type === 'invocation_expression') {
      const fn = childAt(node, 0)
      if (fn !== undefined && fn.type === 'identifier') {
        out.calls.push({ callee: nodeText(fn), line: at.line, col: at.col })
      } else if (fn !== undefined) {
        const id = childOfTypeDeep(fn, 'identifier')
        // member_access: last identifier is the method name
        let last: TSNode | undefined
        const collect = (n: TSNode): void => {
          for (let i = 0; i < n.childCount; i++) {
            const c = childAt(n, i)
            if (c === undefined) continue
            if (c.type === 'identifier') last = c
            collect(c)
          }
        }
        collect(fn)
        const callee = last ?? id
        if (callee !== undefined) out.calls.push({ callee: nodeText(callee), line: at.line, col: at.col })
      }
    } else if (node.type === 'parameter') {
      const typeNode = childOfType(node, 'identifier') ?? childOfType(node, 'predefined_type') ?? childOfType(node, 'qualified_name')
      // First identifier in a parameter is often the type; skip predefined (int).
      if (typeNode !== undefined && typeNode.type !== 'predefined_type') {
        const name = typeNode.type === 'qualified_name' ? (nodeText(typeNode).split('.').pop() ?? nodeText(typeNode)) : nodeText(typeNode)
        out.typeRefs.push({ name, line: at.line, col: at.col })
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = childAt(node, i)
      if (c !== undefined) visit(c)
    }
  }
  visit(root)
  return out
}

/**
 * Resolve a language-specific import specifier to a project file.
 * Relative Python imports (`.base`) become `./base`; otherwise the last
 * path segment is matched against a same-directory (or dotted-path) file
 * with the language's extension.
 */
function resolveWasmImport(
  fromRel: string,
  specifier: string,
  projectFiles: ReadonlySet<string>,
  fileExt: string,
): string | undefined {
  const from = fromRel.replace(/\\/g, '/')
  let spec = specifier.replace(/\\/g, '/').trim()
  const dir = posix.dirname(from)
  // Quoted includes / sourced paths already carry a filename (`speak.h`).
  if (spec.includes('.') || spec.includes('/')) {
    const asPath = posix.normalize(posix.join(dir, spec)).replace(/\\/g, '/').replace(/^\.\//, '')
    if (projectFiles.has(asPath)) return asPath
    const abs = spec.replace(/^\.\//, '')
    if (projectFiles.has(abs)) return abs
  }
  if (/^\.+\w/.test(spec)) {
    const m = spec.match(/^(\.+)(.*)$/)
    if (m !== null) {
      const dots = m[1].length
      const rest = m[2].replace(/^\./, '').replace(/\./g, '/')
      spec = (dots === 1 ? './' : '../'.repeat(dots - 1)) + rest
    }
  }
  const last = spec.split(/[./]/).filter(Boolean).pop() ?? spec
  const bases = spec.startsWith('.')
    ? [posix.normalize(posix.join(dir, spec))]
    : [posix.normalize(posix.join(dir, last)), posix.normalize(spec.replace(/\./g, '/')), posix.normalize(spec)]
  const candidates: string[] = []
  for (const base of bases) {
    candidates.push(base, base + fileExt, `${base}/__init__.py`, `${base}/mod.rs`)
  }
  candidates.push(posix.join(dir, last + fileExt))
  const seen = new Set<string>()
  for (const c of candidates) {
    const n = c.replace(/\\/g, '/').replace(/^\.\//, '')
    if (seen.has(n)) continue
    seen.add(n)
    if (projectFiles.has(n)) return n
  }
  return undefined
}

/** Extract relations for one WASM-language file. */
export async function relationsForWasmFile(
  absPath: string,
  relPath: string,
  projectFiles: ReadonlySet<string>,
  packages?: PackageInfo[],
): Promise<ExtractedRelation[]> {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase()
  const langInfo = WASM_LANGUAGES[ext]
  if (langInfo === undefined) return []

  const { parser, load } = await getParser()
  const wasmFile = langInfo.wasm ?? `tree-sitter-${langInfo.pkg.replace(/^tree-sitter-/, '')}.wasm`
  const language = await load(langInfo.pkg, wasmFile)
  parser.setLanguage(language)
  const source = readFileSync(absPath, 'utf8')
  const tree = parser.parse(source) as { rootNode: TSNode } | null
  if (tree === null) return []

  const extracted = EXTRACTORS[langInfo.ext](tree.rootNode)
  const relations: ExtractedRelation[] = []

  for (const s of extracted.symbols) {
    relations.push({ kind: s.kind, source: relPath, target: s.name, confidence: 'exact', location: { file: relPath, line: s.line, col: s.col } })
  }

  for (const imp of extracted.imports) {
    const local = resolveWasmImport(relPath, imp.specifier, projectFiles, ext)
    const resolved = local ?? (packages !== undefined ? resolvePackageImport(imp.specifier, packages, projectFiles) : undefined)
    if (resolved !== undefined) {
      relations.push({ kind: 'import', source: relPath, target: resolved, confidence: 'exact', location: { file: relPath, line: imp.line, col: imp.col } })
    }
  }

  for (const call of extracted.calls) {
    const sameFile = extracted.symbols.some((s) => s.name === call.callee)
    const at = { file: relPath, line: call.line, col: call.col }
    relations.push({ kind: 'call', source: relPath, target: call.callee, confidence: sameFile ? 'exact' : 'inferred', location: at })
  }

  for (const inh of extracted.inherits) {
    relations.push({ kind: 'inherit', source: relPath, target: inh.parent, confidence: inh.confidence, location: { file: relPath, line: inh.line, col: inh.col } })
  }

  const definedNames = new Set(extracted.symbols.map((s) => s.name))
  for (const ref of extracted.typeRefs) {
    // Same-file defined types are parser-proven (exact). Unresolved names
    // (int, i32, unknown imports) are not emitted — they are not inferred
    // import/export matches (ADR-0004).
    if (definedNames.has(ref.name)) {
      relations.push({ kind: 'type-ref', source: relPath, target: ref.name, confidence: 'exact', location: { file: relPath, line: ref.line, col: ref.col } })
    }
  }

  return relations
}
