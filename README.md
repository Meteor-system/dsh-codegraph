# CodeGraph

A DeepSeek Harness plugin that indexes a project into a relation graph and exposes one agent tool, `codegraph_explore`, answering reachability, callers, and impact questions.

Default-disabled. Installed once per DSH **profile**; enablement and the index store are per project.

## Profile install

From a DSH profile, add the bundle (npm package `dsh-codegraph`, bundle id `dsh-codegraph`):

```bash
# profile-level install — once per DSH profile
npm install dsh-codegraph
```

The bundle patch is `cordis.patch.yml`. Switching projects does not require reinstalling the plugin.

## Per-project enablement

The plugin is **disabled by default**. Enable it for the current project with `<project>/.dsh/codegraph/config.json` (beside the project root, not in the profile):

```json
{ "enabled": true }
```

Or enable from the profile patch (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- id: dsh-codegraph
  config:
    enabled: true
```

Nothing is scanned on enable — the graph builds lazily on the first `codegraph_explore` call. The plugin reads enablement when it loads; restart the session after changing it. An in-flight request keeps its frozen tool set.

## Configuration

Project overrides (budgets, globs, storage):

| Key | Default | Meaning |
|---|---|---|
| `max_file_bytes` | 1_000_000 | Skip files larger than this |
| `max_files` | 50_000 | Stop the scan at this many files |
| `build_timeout_ms` | 300_000 | First-build / refresh wait; exceeded → `indexing` |
| `include` | — | Extra globs to force-include |
| `exclude` | — | Extra globs to force-exclude |

Scan also respects `.gitignore` plus default exclusions (`node_modules`, `dist`, `build`, `.git`, `.dsh`, …).

**Storage:** the index snapshot is `<project>/.dsh/codegraph/`. Keep that directory out of version control.

## Diagnostics

Every result carries enumerable codes. Partial results with diagnostics are preferred over failure or fabrication.

| Code | When |
|---|---|
| `partial` | Scan or extraction skipped some files |
| `unsupported_language` | Language outside shipped extraction (including Razor until its wasm ships) |
| `indexing` | Build/refresh exceeded the timeout; retry |
| `truncated` | Result budget hit (default 50 paths, hard cap 200) |
| `invalid_mode` | `mode` is not `reachability` / `callers` / `impact` |
| `no_path` | Reachability found no path |
| `ambiguous_target` | Multiple symbols matched; use `candidates` |
| `file_oversize` / `file_binary` / `file_decode_failed` | File skipped |
| `file_count_stop` | Scan stopped at `max_files` |

## Limitations

- Syntax-level extraction plus import/export and qualified-name matching. No type checker, no control-flow graph.
- Confidence on every edge: `exact` (parser-proven), `inferred` (cross-file name match), `heuristic` (unresolved / dynamic).
- Razor has no published grammar WASM; `.razor` files currently report `unsupported_language` (`precision: markup-reduced`). See `scripts/build-razor-wasm.md`.
- C/C++ macros are not expanded (heuristic limit).
- Queries are read-only. The index-store write is an internal indexing side effect.

## License

MIT
