# CodeGraph

DeepSeek Harness 插件。把**当前工作区**的源码编成一张关系图，给 agent 一个工具：`codegraph_explore`。

用来回答三件事：谁在调用 X、改 X 会影响谁、X 能不能走到 Y。不是全站搜索，也不是跨仓库的全局索引。

装一次到 DSH **profile**；默许关闭。和 agent 预设无关。

## 一句话怎么调

你不用填 JSON。在已经打开目标仓库的对话里，对 agent 说人话即可：

> 查一下 `graphFor` 都有谁在调用

其它说法同样有效：

- 「改 `activate` 会波及哪些符号」→ impact
- 「`apply` 能不能到达 `graphFor`」→ reachability

agent 会自己调用 `codegraph_explore`。返回路径（如 `src/graph.ts`）都属于**当前这个工作区**，不是「所有装了插件的项目」。换仓库、新开对话，查的就是那个仓库。

## 工作原理

1. 插件装在 DSH profile 里。启用后，这个 profile 下的 agent 都能看到 `codegraph_explore`。
2. 第一次调用才扫描当前会话的工作区根目录，抽出定义 / 调用 / 导入 / 继承 / 类型引用，写成图。
3. 图缓存在 `<项目>/.dsh/codegraph/`。以后每次调用先做增量刷新，再查询；超时（默认 300s）返回 `indexing`，不会一直挂死。
4. 每条边带置信度：`exact`（解析器证明）、`inferred`（跨文件名字匹配）、`heuristic`（猜的）。工具不会把猜测装成定论。
5. 符号有歧义时返回候选列表，不会偷偷挑一个。

查询始终针对**这次对话的工作区**。GUI 进程的家目录、别的仓库，都不会混进这一次结果。

## 安装（每个 DSH profile 一次）

```bash
dsh plugin --profile web add dsh-codegraph
```

本地开发包：

```bash
dsh plugin --profile web add file:./dsh-codegraph-0.1.2.tgz
```

改完 profile 的 patch 后要**重启**该 profile（正在跑的 GUI 不会热替换整棵插件树）。

## 启用

默认关闭。任选一种：

当前项目（写在仓库旁边，不进 profile）：

```json
// <project>/.dsh/codegraph/config.json
{ "enabled": true }
```

或整个 profile 常开（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）：

```yaml
- id: dsh-codegraph
  config:
    enabled: true
```

启用本身不扫描。改启用状态后重启会话；进行中的请求仍用旧工具集。

## `/codegraph`

启用后可以打 `/codegraph`。一次运行会：

1. **Index warmup** — 调 `codegraph_explore`，直到 `metadata.index.status` 不是 `indexing`（图落在当前工作区磁盘上）。
2. **Diff impact pass** — 工作区有未提交改动时，对 diff 里最多 10 个顶层导出符号跑 `callers` / `impact`；干净树跳过这一步。

插件没开时这个命令不存在。技能不是 agent 预设，也不会在打开会话时偷偷建索引。

## 配置

项目级覆盖：

| Key | Default | Meaning |
|---|---|---|
| `max_file_bytes` | 1_000_000 | Skip files larger than this |
| `max_files` | 50_000 | Stop the scan at this many files |
| `build_timeout_ms` | 300_000 | First-build / refresh wait; exceeded → `indexing` |
| `include` | — | Extra globs to force-include |
| `exclude` | — | Extra globs to force-exclude |

Scan 还尊重 `.gitignore` 和默认排除（`node_modules`、`dist`、`build`、`.git`、`.dsh`、`.conda`、`site-packages`、`.venv`、`.claude` 等）。

**Storage:** 索引在 `<project>/.dsh/codegraph/`。不要提交进 git。

## 三种模式

| mode | 问什么 | 典型人话 |
|---|---|---|
| `callers` | 谁调用 target | 查一下 `foo` 都有谁在调用 |
| `impact` | 改 target 影响谁（默认深度 5，上限 20） | 改 `foo` 会波及什么 |
| `reachability` | target 能否到达 `path_to` | `foo` 能不能走到 `bar` |

可选：`scope`（包名或路径前缀）、`limit`（默认 50，硬顶 200）、`confidence`、`relation`、`include_snippets`。

## Diagnostics

结果里带可枚举的 diagnostic 码。宁可部分结果 + 诊断，也不编造。

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
- Confidence on every edge: `exact` / `inferred` / `heuristic`.
- Razor has no published grammar WASM; `.razor` 目前是 `unsupported_language`（`precision: markup-reduced`）。见 `scripts/build-razor-wasm.md`。
- C/C++ macros are not expanded (heuristic limit).
- Queries are read-only. The index-store write is an internal indexing side effect.
- 工具调用上限 300s；超时返回 `indexing`，不会无限等待。

## License

MIT
