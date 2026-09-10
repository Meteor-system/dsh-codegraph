# Testing seam (Ticket 1)

All automated tests go through **one seam**: the bundle's activation entry point, exercised with a lightweight structural test-double context. There is no other test lane.

## How a test activates the bundle and executes the tool

1. Build a fake context with `vitest`:

   ```ts
   import { activate } from '../src/index.ts'
   import type { FakeContext, CapturedRegistration } from '../src/contract.ts'

   const registrations: CapturedRegistration[] = []
   const ctx: FakeContext = {
     registrations,
     unregister(registration) {
       const at = registrations.indexOf(registration)
       if (at !== -1) registrations.splice(at, 1)
     },
     config: { enabled: true, projectRoot: '/proj' },
   }
   ```

2. Activate: `activate(ctx)`. A disabled — or absent — project configuration registers nothing; an enabled project registers exactly one tool named `codegraph_explore`. Re-activation never duplicates: the existing registration is reused.

3. Execute the captured executor with tool-shaped input and assert only on its output:

   ```ts
   const reg = ctx.registrations[0]
   const result = await reg.execute({ mode: 'callers', target: 'foo' })
   ```

4. Disposal: call `reg.disposer()`; the registration is marked disposed and removed via the context's `unregister`.

## Rules

- Assertions read **only** the captured registrations and the executor's input/output JSON — never parser internals, storage layout, or module structure.
- The fake context (`src/contract.ts` — the host-context contract, consumed by tests as the seam) is structural, not imported from any host package; tests run without the DSH host installed.
- When later tickets add behavior (indexing, refresh, budgets), their tests extend the same fake context shape (e.g. fixture project paths on `config.projectRoot`) rather than adding new seams.
