/**
 * The single test seam (Ticket 1): a structural test-double of the host
 * context. It captures tool registrations so tests can assert on the
 * codegraph_explore contract without importing any real host package.
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

/** Structural stand-in for the host context handed to apply(). */
export interface FakeContext {
  /** Where registrations land; assertions read this array. */
  readonly registrations: CapturedRegistration[]
  /** Project-level plugin configuration the activation reads. */
  config: CodeGraphProjectConfig
  /** Alias of registrations for test ergonomics. */
  readonly captured: CapturedRegistration[]
}

/** Per-project enablement state (ADR-0003: lives beside the project root). */
export interface CodeGraphProjectConfig {
  enabled: boolean
  projectRoot: string
}
