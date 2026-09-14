import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * UI acceptance tests run in a DOM (jsdom) against the *local* registry backend,
 * which mirrors the PostgreSQL rules one-to-one. That lets the duplicate guard,
 * search-before-add workflow and role rules be tested without a network.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    css: false,
    restoreMocks: true,
  },
})
