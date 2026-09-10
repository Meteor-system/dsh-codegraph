# ADR-0002: One tool, three modes; agent-scoped registration; never a preset

**Date:** 2026-09-10
**Status:** Accepted

## Context

The plugin must answer three question families — "how does X reach Y", "who calls X", "what does changing X affect" — for a single running agent, without binding to agent presets and without expanding other sessions' tool surface. Host investigation confirmed: `ToolRuntime.register` writes into the calling context's layer (agent-local when called from `agent.ctx`), scoped registrations shadow globals, and a returned disposer supports cleanup on agent disposal or HMR. A built model request freezes its tool assembly, so changes cannot affect an in-flight request.

## Decision

1. **One tool, three modes.** `codegraph_explore` exposes `mode: reachability | callers | impact`, with structured parameters as the primary contract and a natural-language `query` as a supplement. No sibling tools (`codegraph_callers` etc.).
2. **Agent-scoped registration only.** The plugin registers the tool into the running agent's context via `agent.ctx.tools.register`, keeps the disposer, and never registers globally.
3. **Enablement takes effect on the next request assembly.** We do not interrupt an in-flight request; UI/API copy states "available from the next turn".
4. **Standalone activation.** Enablement is a per-project plugin setting (config file/API first, settings-card UI later), independent of any agent preset.

## Consequences

- The tool surface stays small; agents learn one contract with three modes.
- Parallel/other agents never see the tool unless it is enabled in their project and they assemble a new request.
- The frozen-assembly host behavior is a constraint we document rather than work around; no mid-request tool injection.
