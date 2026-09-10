## Parent

#1

## What to build

P2 language set: C, C++, C#, PHP, Ruby, Bash — same contract, fixtures, and metadata updates as the P1 ticket. Naming gotcha respected: npm `tree-sitter-c-sharp` vs release asset `tree-sitter-c_sharp.wasm`; pin grammar versions via npm tarballs.

## Acceptance criteria

- [ ] Each of the six languages indexes a fixture project and answers callers/impact through the standard contract.
- [ ] C/C++: preprocessor-included headers produce `import`-equivalent edges or documented diagnostics (macros noted as heuristic limits).
- [ ] C#: inheritance/interfaces/type-refs extract; namespace-qualified names resolve.
- [ ] PHP/Ruby: dynamic features (duck typing, metaprogramming) fall to `inferred`/`heuristic` with correct labels.
- [ ] Bash: function definitions and call sites extract; sourcing produces import edges or diagnostics.
- [ ] Capabilities metadata and fixture suites updated per language.

## Blocked by

- Ticket 9 (#10, P1 languages)
