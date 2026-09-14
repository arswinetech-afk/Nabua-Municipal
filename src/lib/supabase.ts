/**
 * Supabase connection.
 *
 * The project URL and publishable (anon) key are safe to ship in the browser
 * bundle — Row Level Security and the SECURITY DEFINER RPC functions are what
 * protect the data. Override them with build-time environment variables:
 *
 *   VITE_SUPABASE_URL=https://xxxx.supabase.co
 *   VITE_SUPABASE_ANON_KEY=sb_publishable_xxx
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ||
  'https://ngdyerhiwomreblxqmis.supabase.co'

export const SUPABASE_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() ||
  'sb_publishable_OcGFk8x0h13s9aggSife7w_AgEN5Rkx'

/** Set to 'false' to force purely offline (local storage) operation. */
export const SUPABASE_ENABLED =
  (import.meta.env.VITE_SUPABASE_ENABLED ?? 'true') !== 'false' && !!SUPABASE_URL && !!SUPABASE_KEY

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (!SUPABASE_ENABLED) return null
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'nmbr.auth',
      },
      global: { headers: { 'x-application-name': 'NMBR' } },
      db: { schema: 'public' },
    })
  }
  return client
}

export type ConnectionState = 'unknown' | 'online' | 'offline' | 'unconfigured'

let connectionState: ConnectionState = 'unknown'
const listeners = new Set<(s: ConnectionState) => void>()

export function onConnectionChange(fn: (s: ConnectionState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getConnectionState(): ConnectionState {
  return connectionState
}

function setConnectionState(next: ConnectionState) {
  if (connectionState === next) return
  connectionState = next
  listeners.forEach((l) => l(next))
}

/** Lightweight reachability probe against the Supabase REST endpoint. */
export async function probeConnection(timeoutMs = 4500): Promise<ConnectionState> {
  if (!navigator.onLine) {
    setConnectionState('offline')
    return 'offline'
  }
  if (!SUPABASE_ENABLED) {
    setConnectionState('unconfigured')
    return 'unconfigured'
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      signal: controller.signal,
      cache: 'no-store',
    })
    // Any HTTP answer (even 401) proves the network path works.
    setConnectionState('online')
    return res.ok || res.status < 500 ? 'online' : 'offline'
  } catch {
    setConnectionState('offline')
    return 'offline'
  } finally {
    clearTimeout(timer)
  }
}

export function watchConnectivity() {
  const update = () => setConnectionState(navigator.onLine ? 'online' : 'offline')
  window.addEventListener('online', update)
  window.addEventListener('offline', update)
  update()
  return () => {
    window.removeEventListener('online', update)
    window.removeEventListener('offline', update)
  }
}
