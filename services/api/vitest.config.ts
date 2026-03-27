import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Run in Node.js environment (not browser)
    environment: 'node',

    // ESM-compatible test globals (describe, it, expect, vi)
    globals: false,

    // Resolve .js extensions to .ts in test imports
    // (TypeScript ESM imports use .js but files are .ts)
    alias: {
      // Ensure vitest resolves tsx-based imports correctly
    },

    // Run tests sequentially to avoid shared-state collisions
    // between route integration tests that build the Fastify app.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },

    // Show detailed test output
    reporter: 'verbose',

    // Include only test files
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],

    // Exclude compiled output and node_modules
    exclude: ['dist/**', 'node_modules/**'],
  },
})
