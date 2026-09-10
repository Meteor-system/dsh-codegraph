## Problem Statement

An agent working inside a project answers "how does X reach Y", "who calls X", and "what does changing X affect" by issuing many `Read`/`Grep` calls. Each call is slow, burns the agent's context with irrelevant lines, and still produces fragile conclusions: grep matches text, not symbols, so overloads, same-name functions, and cross-package types get conflated. The DSH user watches their agent spend most of a session re-deriving a mental map of the codebase that a machine could hold precisely.

## Solution

A standalone DSH bundle plugin, **CodeGraph** (npm package `dsh-codegraph`, bundle id `dsh-codegraph`), that indexes the project's source into a relation graph and exposes a single agent tool, `codegraph_explore`. The tool answers reachability, callers, and impact questions directly from the graph, returning compact evidence paths (symbol, file, line/col, relation kind, confidence) instead of raw file dumps. The plugin is default-disabled; when the user enables it for the current project, the currently running agent gains the tool from its next request assembly. The graph is built lazily on first use and refreshed incrementally before each call, so enablement is free and answers are always snapshot-consistent.

## User Stories

1. As a DSH user, I want the CodeGraph plugin disabled by default, so that my projects gain no tools or background work I did not ask for.
2. As a DSH user, I want to enable the plugin per project, so that indexing and tool exposure apply only where I decide.
3. As a DSH user, I want enablement to take effect for my currently running agent from its next request, so that I do not have to restart a session.
4. As a DSH user, I want the plugin installable once per DSH profile, so that switching projects does not require reinstalling anything.
5. As a DSH user, I want the index stored inside my project in an ignorable directory, so that the cache follows the code and never enters version control.
6. As a DSH user, I want nothing scanned when I merely enable the plugin, so that enabling is free on a large repository.
7. As an agent, I want a `codegraph_explore` tool, so that I can answer structural code questions without dozens of Read/Grep calls.
8. As an agent, I want a `reachability` mode, so that I can prove whether and how X reaches Y through the graph.
9. As an agent, I want a `callers` mode, so that I can enumerate who calls a symbol before refactoring it.
10. As an agent, I want an `impact` mode with bounded transitive closure, so that I can report what a change to a symbol affects without unbounded traversal.
11. As an agent, I want structured parameters as the primary contract, so that my queries are stable and reviewable.
12. As an agent, I want a natural-language `query` parameter as a supplement, so that I can express loose questions without guessing the exact symbol first.
13. As an agent, I want candidate lists for ambiguous symbols, so that I never receive a silent guess when overloads or same-name functions exist.
14. As an agent, I want a confidence label (`exact`/`inferred`/`heuristic`) on every relation, so that I can distinguish parser-proven edges from inferred or text-level evidence.
15. As an agent, I want to filter results by confidence and relation kind, so that I can demand only proven edges when precision matters.
16. As an agent, I want results bounded by default (≤ 50 relation paths, ranked), so that one call cannot flood my context.
17. As an agent, I want a `limit` parameter with a hard cap, so that I can widen a query deliberately instead of by accident.
18. As an agent, I want snippets off by default and 1–3 locating lines when enabled, so that evidence is verifiable without paying for full file contents.
19. As an agent, I want enumerable diagnostics (`partial`, `unsupported_language`, `indexing`, `truncated`, file-skip reasons), so that I always know what an answer does not cover.
20. As an agent, I want per-language capabilities declared in each result, so that I can calibrate trust before acting on a conclusion.
21. As an agent, I want `indexing` status with progress and retry info on timeout, so that I can wait and retry instead of failing.
22. As an agent, I want every edge to carry a file/line/col location, so that I can verify any claim by reading the underlying file when stakes are high.
23. As an agent, I want package/module boundaries recorded inside the graph, so that monorepo impact analysis respects package edges.
24. As a DSH user, I want the graph built lazily on first tool call, so that the first use costs one bounded indexing pass and nothing before that.
25. As a DSH user, I want incremental refresh before each call, so that answers reflect the code as it is now without full rebuilds.
26. As a DSH user, I want single-flight updates per project, so that concurrent agent queries never race or interleave index writes.
27. As a DSH user, I want queries to run against a consistent snapshot, so that no answer mixes two states of the graph.
28. As a DSH user, I want default resource budgets (skip files > 1 MB, stop at 50,000 files, first build timeout 120 s), so that a pathological repository cannot stall my agent session.
29. As a DSH user, I want every skipped file reported in diagnostics, so that coverage gaps are never silent.
30. As a DSH user, I want the scan to respect ignore rules with sensible default exclusions, so that dependencies and build output never pollute the graph.
31. As a DSH user, I want project-level include/exclude globs, so that I can tune scope for generated or vendored code.
32. As a DSH user, I want a schema-versioned index store, so that plugin upgrades rebuild stale caches instead of answering from incompatible data.
33. As a DSH user, I want the tool to be read-only and approval-free, so that my agent's graph queries flow without approval prompts even under restrictive policies.
34. As a DSH user, I want to enable and configure the plugin through config file/API in headless environments, so that CI or remote setups work without a GUI.
35. As a plugin maintainer, I want registration scoped to the agent's context with a disposer, so that session end and hot reloads never leak tools.
36. As a plugin maintainer, I want parser grammar assets vendored with the plugin, so that host updates can never break our parsing stack.
37. As a DSH user, I want common single-byte encodings auto-detected and undecodable files skipped with a diagnostic, so that real-world Windows repositories still index cleanly.
38. As an agent, I want the tool description to teach the three modes, parameter meanings, and diagnostics vocabulary, so that I use the tool correctly on first contact without external docs.

## Implementation Decisions

These follow the four accepted ADRs; this spec cites rather than repeats them.

- **Bundle shape.** A standalone DSH bundle: npm package `dsh-codegraph`, bundle id `dsh-codegraph`, display name "CodeGraph". Declares a `dsh.bundle.patch`; installed once per profile via the normal `dsh plugin` flow. Not an agent preset, never a global tool registration.
- **Registration seam.** On activation for an agent, the plugin registers exactly one tool definition, `codegraph_explore`, into the agent's own tool context via the scoped register call, and retains the returned disposer for agent disposal and HMR reload. No other tools, no global registration. (ADR-0002)
- **Tool contract.** One tool, three modes. Input (all optional except the target): `mode` (`reachability` | `callers` | `impact`), target expressed as symbol name, qualified name, or file:line position; `query` (natural-language supplement); `max_depth` (impact; default 5, hard cap); `relation` filter (definition/call/import/inherit/type-ref); `confidence` filter (exact/inferred/heuristic); `scope` (path or package prefix); `limit` (default 50, hard cap 200); `include_snippets` (default false). Output: mode echo; relation paths as ordered edges — each edge carries kind, confidence, source/target symbol identity, and file/line/col; candidate list when the target is ambiguous (ranked by qualified-name/path/language/line match); diagnostics array with enumerated codes; metadata block with per-language capabilities, index status, and `truncated` + total count when applicable. (ADR-0004)
- **Parser stack.** Plugin-owned: web-tree-sitter runtime plus per-language grammar WASMs vendored into the package. Syntax-level relations (definition, call, import, inherit, type-ref) extracted uniformly per grammar; cross-file semantic resolution layered via import/export matching and qualified-name matching, labeled `inferred`; text-level fallbacks labeled `heuristic`. (ADR-0001)
- **Language capability stages.** P1: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java. P2: C, C++, C#, PHP, Ruby, Bash. P3: Haskell, Julia, Scala, Razor. A language outside shipped stages is recognized by extension but yields `unsupported_language` diagnostics. The capabilities metadata block states each language's stage and precision.
- **Index lifecycle.** Lazy build on first tool call after enablement; before each call, detect file changes and run a single-flight incremental refresh; queries execute against the resulting consistent snapshot. On build/refresh timeout: `indexing` status with progress and retry guidance, never a stale answer. No filesystem watchers in v1. (ADR-0003)
- **Index store.** On-disk graph cache under the project's `.dsh/codegraph/` directory, excluded by default ignore rules, schema-versioned; version mismatch forces full rebuild. Enablement state and any per-project overrides live beside the project root, not in the profile. (ADR-0003)
- **Scan scope.** Respect `.gitignore` plus default exclusions (dependency directories, build output, caches, VCS metadata); index only supported-language source files; project include/exclude globs may widen or narrow scope. (ADR-0003)
- **Resource budgets.** Defaults, overridable per project: skip files > 1 MB (diagnostic); stop scanning at 50,000 files (diagnostic); first-build timeout 120 s. Every deviation is surfaced as a diagnostic. (ADR-0003)
- **Evidence rules.** Confidence on every edge; candidate disambiguation with no silent picks; impact as bounded transitive closure with direct/transitive layers; result budget default 50 ranked relation paths with `truncated` + total; snippets opt-in at 1–3 locating lines; lines > 10,000 characters truncated in snippet output. (ADR-0004)
- **Read-only posture.** The tool requires no per-call approval; the index-store write is an internal side effect stated in the result metadata. Host approval-policy semantics (`never` deterministically rejects ask-tools) are thereby respected. (ADR-0004)
- **Encoding.** UTF-8 primary; BOM/common single-byte encodings auto-detected; binary and undecodable files skipped with diagnostics.
- **Monorepo handling.** One graph per project root; package/module boundaries recorded as first-class nodes/edges within the single graph.
- **Configuration surface (v1).** Profile-level install plus project-level enablement and overrides via config file/API. Settings-card UI is phase 2 (Out of Scope).

## Testing Decisions

- **Single seam: the tool contract.** All automated tests go through one seam — the bundle's apply/activation entry point, invoked with a lightweight test-double context that captures tool registrations; tests then execute the captured `codegraph_explore` executor and assert purely on its input/output JSON. Parser, extractor, graph store, and query engine are internal implementation details and are never tested directly; they are exercised through the contract.
- **Good tests** assert external behavior only: given a fixture project and a tool call, what edges, candidates, diagnostics, and metadata come back. No AST internals, no storage layout, no module boundaries in assertions.
- **Fixture projects** are the primary art: small, hand-verifiable multi-file projects per language (call chains, imports, inheritance, overloads for disambiguation cases, oversized/binary/odd-encoding files for diagnostics), each with expected outputs reviewed by a human.
- **Contract-observable lifecycle tests** cover: lazy build on first call; incremental refresh after file edits (write fixture, query, assert new edge appears); schema-version bump triggering rebuild (observable via metadata/diagnostics); budget defaults (oversize skip, file-count stop, timeout → `indexing` status); truncation at the 50-path default; snippet opt-in shape.
- **Registration tests** assert exactly one tool registered into the agent-scoped context, the disposer releasing it, and no global registration.
- No end-to-end host tests in v1 (no real profile install, no browser, no GUI) — the phase-2 settings card brings its own test layer when it exists.

## Out of Scope

- Settings-card UI (phase 2; config file/API carries v1).
- Filesystem watchers or background re-indexing between calls.
- Deep semantic analysis: type inference beyond import/export and qualified-name matching; control-flow or data-flow graphs; variable read/write edges; test-coverage edges.
- Cross-repository graphs; anything outside the current project root.
- Any write operation on project files; the tool is read-only.
- Agent-preset integration of any kind.
- Per-language LSP servers or compiler frontends.
- Syntax highlighting or editor features (host UI concern).

## Further Notes

- Host facts the design relies on (verified against installed DSH 0.1.2-rc.1): tool registration is agent-scoped with disposer cleanup; a built model request freezes its tool assembly, so enablement takes effect from the next request; the bundle mechanism is profile-level (`dsh.profile.bundles`); the host ships no reusable parser/AST API, so the plugin owns its stack (ADR-0001).
- Grammar supply: 14 of 15 languages have MIT official grammar npm packages shipping prebuilt WASM (TypeScript package ships separate tsx wasm; JSX covered by the JavaScript grammar). Razor is the sole gap — the viable community grammar (MIT, ABI 15) publishes no artifacts and must be built from source into WASM at plugin build time; P3 razor ships reduced capability behind the diagnostics contract.
- The repo hosting this spec (Meteor-system/dsh-codegraph) is the plugin's own workspace; implementation tickets split from this spec live in this tracker.
