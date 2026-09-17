import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Must be set before src/lib/supabase.ts is imported (setup files run first), so
// the suite exercises the offline registry path and never opens a socket.
process.env.VITE_SUPABASE_URL = ''
process.env.VITE_SUPABASE_ANON_KEY = ''
process.env.VITE_SUPABASE_ENABLED = 'false'

/**
 * The tests exercise the offline path (LocalApi + outbox), which is the same code
 * path the office uses when the municipal link drops. No Supabase host is
 * contacted, so the suite runs anywhere.
 */
// The persons mirror lives in IndexedDB (municipal scale outgrows the
// ~5 MB localStorage quota); give every case a clean virtual database.
import 'fake-indexeddb/auto'
beforeEach(async () => {
  const { idbClose } = await import('../src/lib/idb')
  await idbClose()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('nmbr-store')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // Force "no server configured" so the client uses the local registry.
  vi.stubEnv('VITE_SUPABASE_URL', '')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
  vi.stubEnv('VITE_SUPABASE_ENABLED', 'false')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllEnvs()
})

// jsdom lacks these APIs, which the UI relies on for exports and toasts.
if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

if (!('ResizeObserver' in window)) {
  // @ts-expect-error - minimal stub for jsdom
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:nmbr-test'
  URL.revokeObjectURL = () => undefined
}
