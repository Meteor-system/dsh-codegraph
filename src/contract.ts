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
