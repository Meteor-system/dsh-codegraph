# ADR-0005: TS-family files parse via typescript@5.9.3 (pinned); tree-sitter covers the rest

**Date:** 2026-09-10
**Status:** Accepted

## Context

ADR-0001 committed the plugin to a web-tree-sitter + grammar-WASM stack for all languages. Implementing Ticket 2 (lazy index for TypeScript/TSX/JSX) surfaced a decisive trade-off: the official `typescript` compiler package offers `ts.createSourceFile` — exact TS/TSX/JSX semantics natively in Node (ScriptKind by extension, no wasm loading, no build step) — while the grammar-wasm route adds ~2.9 MB of wasms plus a runtime init step for identical syntax-level fidelity on these four languages. Meanwhile `typescript@latest` (7.0.2, the Go-native port) has removed the classic JS API, so the version must be pinned; 5.9.3 is the last line with the documented Compiler API surface.

## Decision

- Source files of the TS family (`.ts`, `.tsx`, `.js`, `.jsx`) parse with the **`typescript` package pinned to `5.9.3`** (Apache-2.0), via `createSourceFile` + `forEachChild` + `SyntaxKind` traversal. No type checker is created: extraction is syntax-level, per ADR-0001.
- All other languages (P1 remainder: Python, Go, Rust, Java; then P2/P3) use the **web-tree-sitter + grammar-wasm** stack as planned in ADR-0001. Both adapters produce the same relation model, so extraction results are adapter-agnostic.
- The pin is deliberate and reviewed: upgrading past 5.x requires re-validating the API surface (TypeScript 7 removes it).

## Consequences

- One runtime dependency (~24 MB unpacked) instead of four wasm loads for the highest-traffic languages; TSX/JSX handled natively.
- Two extraction adapters exist behind one relation model; per-language capability metadata already declares stage/precision, so consumers need no change.
- A future uniform migration of the TS family onto tree-sitter (single adapter) remains open and is a candidate ADR, not a silent swap — consistent with ADR-0001's migration clause.
