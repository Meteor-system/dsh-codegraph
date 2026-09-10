import { defineConfig } from 'vitest/config'

// Single test lane: everything goes through the one agreed seam — the
// bundle's apply(ctx) activation captured by a lightweight test-double
// context; assertions read only codegraph_explore inputs/outputs.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    testTimeout: 20_000,
  },
})
