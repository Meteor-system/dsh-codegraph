## Parent

#1

## What to build

P1 language set per ADR-0001's capability stages: Python, Go, Rust, Java grammars vendored (MIT official packages ship prebuilt WASM), extraction rules per language for the five relation kinds, and a hand-verifiable fixture suite per language exercising the full contract (definitions, calls, imports, inheritance, type references) with confidence labels and capabilities metadata updated.

## Acceptance criteria

- [ ] Each of the four languages indexes a fixture project and answers callers/impact through the standard contract.
- [ ] Inheritance/implementation edges extract per language semantics (traits/interfaces/impls/base classes).
- [ ] Type references extract as `type-ref` edges.
- [ ] Confidence labels correct on language-specific known-exact vs known-inferred fixtures.
- [ ] Capabilities metadata reflects the four languages' stage/precision.
- [ ] Each language has a documented fixture suite with hand-verified expected outputs.

## Blocked by

- Ticket 6 (#7, evidence contract — confidence/candidate semantics all languages build on)
