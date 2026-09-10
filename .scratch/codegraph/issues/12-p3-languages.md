## Parent

#1

## What to build

P3 language set: Haskell, Julia, Scala, Razor — same contract, fixtures, and metadata updates. Razor is the sole language without a published grammar: build the wasm from source (community grammar, MIT, parser ABI 15) at plugin build time; ship reduced capability behind the diagnostics contract if extraction fidelity is limited.

## Acceptance criteria

- [ ] Haskell/Julia/Scala index fixtures and answer through the standard contract.
- [ ] Razor wasm builds reproducibly from the pinned community grammar source at plugin build time; the build step is documented.
- [ ] Razor `.razor` files either extract markup-level relations with declared precision or yield `unsupported_language`/`partial` diagnostics — both acceptable, both tested.
- [ ] Capabilities metadata reflects P3 stages and Razor's reduced precision.
- [ ] Fixture suites per language with hand-verified expectations.

## Blocked by

- Ticket 10 (#11, P2 languages)
