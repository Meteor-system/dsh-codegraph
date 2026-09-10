# ADR-0001: Plugin owns its parser stack (web-tree-sitter + bundled grammar WASMs)

**Date:** 2026-09-10
**Status:** Accepted

## Context

The plugin must parse 18 languages (bash, c, cpp, csharp, go, haskell, java, javascript, jsx, julia, php, razor, ruby, rust, scala, tsx, typescript) into a relation graph. We surveyed the installed DSH host (0.1.2-rc.1): there is no tree-sitter package, no grammar assets usable as a stable API (the web frontend's TextMate chunks are private, hashed Vite artifacts for display only), and the documented `ctx.lsp` seam is a contract projection in generated API docs with no provider implementation in the installed checkout. Per-language LSP servers or compiler frontends would each need bundling, far exceeding a plugin's footprint.

## Decision

The plugin bundles **web-tree-sitter** plus per-language **tree-sitter grammar WASM files** and owns all extraction. Syntax-level relations (definition, call, import, inherit, type-ref) are extracted uniformly per grammar. Cross-file semantic resolution (type inference, overload selection) is layered on top with import/export matching and qualified-name matching, always labeled with confidence (`exact` / `inferred` / `heuristic`).

## Consequences

- The plugin works wherever web-tree-sitter runs; no host upgrades are needed.
- Grammar WASMs and the tree-sitter runtime are delivered and versioned with the plugin package.
- Razor has no mainstream tree-sitter grammar; its P3 stage may ship reduced capability (markup-level relations) behind the capability/diagnostics contract.
- Semantic depth is bounded by heuristics; the confidence label keeps agents from mistaking inference for proof.
- If the host later ships a stable parser/LSP API, migrating extraction to it is a candidate ADR, not a silent swap.

## Verified grammar facts (2026-09-10 research, primary sources)

- **Runtime**: `web-tree-sitter` (MIT, v0.27.0) loads per-language `.wasm` grammars in Node and browsers; it ships its own ~210 KB runtime wasm. Parser ABI 13–15 supported from web-tree-sitter ≥ 0.25.0.
- **Official grammars**: MIT-licensed npm packages exist for all 14 non-Razor languages (bash 0.25.1, c 0.24.1, cpp 0.23.4, c-sharp 0.23.5, go 0.25.0, haskell 0.23.1, java 0.23.5, javascript 0.25.0, julia 0.23.1, php 0.24.2, python 0.25.0, ruby 0.23.1, rust 0.24.0, scala 0.24.0, typescript 0.23.2). None archived.
- **JSX/TSX**: covered by `tree-sitter-javascript` (JSX rules + `highlights-jsx.scm`) and `tree-sitter-typescript`, which ships separate `tree-sitter-tsx.wasm` / `tree-sitter-typescript.wasm` artifacts.
- **Naming gotchas**: npm `tree-sitter-c-sharp` vs release asset `tree-sitter-c_sharp.wasm` (underscore); prefer npm tarballs or `tree-sitter build --wasm` over release assets for determinism.
- **Razor is the sole gap**: official `tree-sitter/tree-sitter-razor` is an archived 2016 WIP; the viable candidate is `tris203/tree-sitter-razor` (MIT, active, parser ABI 15, adopted by tree-sitter-language-pack and Zed extensions) but it publishes **no tags/releases/npm artifacts** — build-from-source only (`tree-sitter build --wasm`). The npm name `tree-sitter-razor` is an unpublished tombstone.
- **Bundling wasm in npm packages is standard practice**: the official README recommends consuming grammars from npm; verified examples include `tree-sitter-javascript@0.25.0` (412 KB wasm in tarball), `tree-sitter-typescript@0.23.2` (two wasm artifacts), and aggregator `tree-sitter-wasms@0.1.13` (34 grammars, Unlicense, no razor). Aggregators are useful for pinning, but razor cannot come from them.
