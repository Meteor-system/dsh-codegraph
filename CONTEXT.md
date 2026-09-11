# CONTEXT.md

Domain vocabulary for the CodeGraph plugin for DSH. Use these terms consistently in issues, specs, code, and tool output.

## What this is

A standalone DSH bundle plugin (npm package `dsh-codegraph`, bundle id `dsh-codegraph`, display name **CodeGraph**) that indexes a project's source code into a queryable graph and exposes one agent tool, `codegraph_explore`, answering "how does X reach Y", "who calls X", and "what does changing X affect". Default-disabled; enabled per project; installed once per DSH profile; never coupled to agent presets.

## Glossary

- **CodeGraph plugin** — the standalone bundle. Registers its tool into the running agent's scope at runtime (`ctx.tools.register`); it is not an agent preset and never registers globally.
- **`codegraph_explore`** — the single agent tool. One tool, three modes: `reachability` (X reaches Y), `callers` (who calls X), `impact` (what changing X affects). Structured parameters are the primary entry; a natural-language `query` supplements them, never replaces them.
- **Index snapshot** — the consistent, schema-versioned state of the graph a query runs against. Built lazily on first tool call; refreshed by a single-flight incremental pass before each call when files changed. Queries wait for a consistent snapshot; on timeout they return `indexing` status with progress and retry info.
- **Relation** — a directed edge in the graph. First-release kinds: `definition`, `call`, `import`, `inherit` (inheritance/implementation), `type-ref`.
- **Confidence** — per-edge label: `exact` (parser-proven), `inferred` (cross-file export/qualified-name matching), `heuristic` (text-level evidence, including supplemental search). Always present; agents can filter on it. The tool never disguises a guess as a proven relation.
- **Candidate disambiguation** — when a symbol resolves to multiple graph nodes, the tool returns ranked candidates (qualified name, path, language, line) and asks the agent to disambiguate. It never silently picks.
- **Project root** — the DSH project's root directory. One graph per project root; monorepo packages live inside that single graph with their package/module boundaries recorded.
- **Index store** — the on-disk graph cache at `<project>/.dsh/codegraph/`, excluded by default ignore rules and versioned by schema; a schema/version mismatch forces a rebuild. Project enablement state lives beside the project root, not in the profile.
- **Capability stage** — the per-language parser delivery phase. P1: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java. P2: C, C++, C#, PHP, Ruby, Bash. P3: Haskell, Julia, Scala, Razor. A language outside shipped stages yields `unsupported_language`.
- **Diagnostics** — structured, enumerable status codes in every result: `partial`, `unsupported_language`, `indexing`, `truncated`, plus file-skip reasons (oversize, binary, decode failure). Partial results with diagnostics are always preferred over failure or fabrication.
- **Resource budget** — default caps, overridable per project: skip files over 1 MB; stop scanning at 50,000 files; first build / tool-call timeout 300 s; query returns at most 50 relation paths by default (limit parameter up to a hard cap of 200); snippets off by default, 1–3 locating lines each when enabled; lines over 10,000 characters truncated.
- **Scan scope** — files eligible for indexing: respect `.gitignore` plus default exclusions (dependencies, build output, caches, VCS dirs); only supported-language source files; project-level include/exclude globs may override.
- **Read-only tool** — `codegraph_explore` queries are read-only and request no per-call approval; the index-store write is an internal indexing side effect, stated in the result.
- **Activation timing** — enabling or disabling the plugin takes effect at the next prompt/request assembly; an in-flight model request keeps its frozen tool set.

## Host facts this design relies on

- Tool registration is agent-scoped: the plugin registers into the target agent's context and receives a disposer for session end or HMR cleanup.
- A built model request freezes its tool assembly; availability changes apply from the next request on.
- The bundle installs once per DSH profile (`dsh.profile.bundles`); enablement and the index store are per project root.
- The host ships no reusable AST/tree-sitter API (the documented `ctx.lsp` seam is a contract projection with no provider implementation); the plugin owns its parser stack (ADR-0001).
