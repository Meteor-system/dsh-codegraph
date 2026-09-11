/**
 * The single test seam (Ticket 1): a structural stand-in for the host
 * context contract. It defines the host-facing shape the bundle activates
 * against — captured tool registrations plus per-project configuration —
 * so tests can assert on the codegraph_explore contract without importing
 * any real host package.
 *
 * Tests activate the bundle through `activate(fakeCtx)` and execute the
 * captured executor with tool-shaped inputs; every assertion reads only
 * those inputs and outputs.
 */

/** The subset of a registered tool definition the seam observes. */
export interface CapturedRegistration {
  name: string
  description: string
  parametersSchema: unknown
  execute(input: unknown): Promise<unknown>
  disposed: boolean
  disposer(): void
}

/**
 * Structural stand-in for the host context handed to activate().
 * Owns its registration list: removal goes through unregister(), never
 * by reaching into the array from outside (ownership stays with the
 * object that holds the data).
 */
export interface FakeContext {
  /** Where registrations land; assertions read this array. */
  readonly registrations: CapturedRegistration[]
  /** Remove a previously captured registration (disposer's exit path). */
  unregister(registration: CapturedRegistration): void
  /** Project-level plugin configuration the activation reads. */
  config: CodeGraphProjectConfig
}

/** Per-project enablement state (ADR-0003: lives beside the project root). */
export interface CodeGraphProjectConfig {
  enabled: boolean
  projectRoot: string
  /**
   * Project-level budget/scope overrides (ticket 7): max_file_bytes,
   * max_files, build_timeout_ms, include globs, exclude globs.
   */
  overrides?: Record<string, unknown>
}

/**
 * The real host (cordis) tool-run context. Duck-typed so the bundle does
 * not import `@deepseek-ai/dsh-tools` — that package lives in the DSH
 * install, not in an out-of-tree plugin's node_modules.
 */
export interface HostToolExec {
  agent?: { session?: { header?: { cwd?: string } } }
  /** Host timeout policy aborts this after `timeoutMs`. */
  signal?: AbortSignal
}

/** The subset of a host tool definition `ctx.tools.register` accepts. */
export interface HostToolDefinition {
  name: string
  description: string
  parameters: unknown
  output: {
    schema: unknown
    render(args: unknown, value: unknown): Array<{ type: string; text: string }>
  }
  execute(args: unknown, exec?: HostToolExec): Promise<unknown>
  isConcurrencySafe?(): boolean
  /** Cooperative tool-call budget (ms). Omit = no host deadline. */
  timeoutMs?: number
}

/** Runtime skill contribution `ctx.skills.register` accepts (duck-typed). */
export interface HostSkillRegistration {
  name: string
  description: string
  content: string
  /** Origin bucket; host load validation requires a string (`runtime` for embedded skills). */
  source: string
  invocation?: {
    modelInvocable: boolean
    userInvocable: boolean
  }
}

/** Structural stand-in for the cordis context `apply()` receives. */
export interface HostContext {
  tools: {
    register(definition: HostToolDefinition): () => void
  }
  /**
   * Optional skill registry. Absent on hosts that have no `ctx.skills`;
   * apply must still register the tool and must not throw.
   * Real DSH hosts expose this via `ctx.get('skills')` without a hard inject.
   */
  skills?: {
    register(skill: HostSkillRegistration): () => void
  }
  /** Optional Cordis lookup; used so we never read `ctx.skills` without inject. */
  get?(name: string): unknown
}

/** Cordis row `config` plus optional project-root override. */
export interface HostPluginConfig {
  enabled?: boolean
  projectRoot?: string
  overrides?: Record<string, unknown>
}
