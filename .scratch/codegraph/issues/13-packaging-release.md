## Parent

#1

## What to build

Packaging hardening and release readiness: grammar assets pinned and version-locked, prepack/build pipeline producing a publishable npm package, ABI compatibility check (web-tree-sitter ≥ 0.25 for parser ABI 15), plugin README (install, enable, configure, troubleshoot), and a release checklist. After this ticket the plugin installs from the real registry via the normal profile flow.

## Acceptance criteria

- [ ] All grammar wasm assets pinned to exact versions with a provenance record (package + version + license per asset; Razor's source-built wasm documents its commit).
- [ ] `prepack` produces a complete publishable artifact; a dry-run publish succeeds.
- [ ] ABI compatibility asserted in CI (grammar ABI ≤ web-tree-sitter supported ABI).
- [ ] README covers: profile install, per-project enablement, configuration (budgets, globs, storage), diagnostics reference, and limitations.
- [ ] Release checklist documents versioning policy (schema-version bumps force client rebuilds) and how to upgrade grammars.
- [ ] Fresh install from the built package through the profile flow works end to end on a sample project.

## Blocked by

- Ticket 9 (#10, P1 languages)
