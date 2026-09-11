# Build Razor grammar WASM (ticket 11 / #12)

Razor has no published npm grammar (ADR-0001). The viable source is the
community grammar `tris203/tree-sitter-razor` (MIT, parser ABI 15).
Until that WASM is produced, `.razor` files are scanned and reported
with `unsupported_language` and capability `precision: markup-reduced`.

## Reproducible build

Requires the Tree-sitter CLI (`npm i -g tree-sitter-cli@0.25`) and a
WASM toolchain the CLI accepts (`tree-sitter build --wasm`).

```bash
# Pin the community grammar at a git commit and record it here when
# the artifact is first produced (packaging ticket owns the provenance table).
git clone https://github.com/tris203/tree-sitter-razor.git
cd tree-sitter-razor
git checkout <pinned-commit>
tree-sitter build --wasm
```

Copy the resulting `tree-sitter-razor.wasm` next to the other grammar
WASMs (or into `grammars/`) and register `.razor` in `WASM_LANGUAGES`.
A schema/version bump is not required; the next index rebuild picks it up.
