# Release checklist

Use this before publishing `dsh-codegraph`.

## Versioning

- npm package version is independent of the **snapshot schema version** (`SNAPSHOT_SCHEMA_VERSION` in `src/model.ts`, currently `4`).
- Bumping the schema version forces every client to **rebuild** the on-disk graph at `<project>/.dsh/codegraph/` on the next tool call. Do not bump it for grammar-only upgrades.
- Grammar upgrades (new parser ABI, changed extraction) do **not** require a schema bump; the next incremental/full rebuild picks up new edges.

## Grammar upgrades

1. Pin the grammar npm package to an **exact** version in `package.json` (no `^` / `~`).
2. Confirm the package ships a `.wasm` (C# uses `tree-sitter-c_sharp.wasm`).
3. Update `grammars/provenance.json` (package, version, license, wasm filename).
4. Run `npm test` — `tests/packaging.spec.ts` checks provenance pins and ABI (`grammar ABI ≤ web-tree-sitter LANGUAGE_VERSION` and `≥ MIN_COMPATIBLE_VERSION`).
5. If Razor wasm is produced, record the git **commit** in `grammars/provenance.json` `razor.commit` and follow `scripts/build-razor-wasm.md`.

## Publish

1. `npm run check` (typecheck, build, test).
2. `npm publish --dry-run` — tarball must include `lib/`, `cordis.patch.yml`, `LICENSE`, `README.md`, `grammars/provenance.json`.
3. Publish to the registry in `publishConfig`.
4. Install from the registry into a DSH profile and enable the plugin on a sample project; first `codegraph_explore` call should rebuild the index (lazy).
