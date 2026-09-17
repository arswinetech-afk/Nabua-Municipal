import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getApi, type ApiClient, type ServerStatus, type SyncEvent } from '../lib/apiClient'
import { getConnectionState, onConnectionChange, type ConnectionState, probeConnection } from '../lib/supabase'
import type { SessionUser } from '../lib/api'
import type { SystemSettings } from '../lib/types'
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from '../lib/duplicateEngine'
import { useToast } from '../components/ui'

type AppState = {
  api: ApiClient
  user: SessionUser | null
  ready: boolean
  settings: SystemSettings
  connection: ConnectionState
  online: boolean
  usingServer: boolean
  pendingCount: number
  lastSync: string | null
  sessionNotice: string | null
  /** Queued work is parked because the municipal server has no session from this device. */
  needsSignIn: boolean
  /** Whether the central database has been set up (see ServerStatus). */
  serverStatus: ServerStatus
  recheckServer: () => Promise<ServerStatus>
  signIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  signOut: () => Promise<void>
  refreshSettings: () => Promise<void>
  sync: () => Promise<{ pushed: number; failed: number; conflicts: number }>
  refreshPending: () => void
}

const defaultSettings: SystemSettings = {
  weights: { ...DEFAULT_WEIGHTS },
  thresholds: { ...DEFAULT_THRESHOLDS },
  session_timeout_minutes: 30,
  mask_contact_in_lists: true,
  block_on_very_likely: true,
  require_reason_on_edit: true,
  municipality: 'Nabua',
  province: 'Camarines Sur',
}

const AppContext = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const api = useMemo(() => getApi(), [])
  const toast = useToast()
  const [user, setUser] = useState<SessionUser | null>(null)
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<SystemSettings>(defaultSettings)
  const [connection, setConnection] = useState<ConnectionState>(getConnectionState())
  const [pendingCount, setPendingCount] = useState(0)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [serverStatus, setServerStatus] = useState<ServerStatus>(() => api.serverStatus)
  const [tick, setTick] = useState(0)
  const userRef = useRef<SessionUser | null>(null)
  const storageWarned = useRef(false)

  const refreshPending = useCallback(() => {
    setPendingCount(api.pendingChanges().filter((p) => p.status !== 'DONE').length)
    setLastSync(api.lastSyncedAt())
    setServerStatus(api.serverStatus)
    setNeedsSignIn(api.needsSignIn)
  }, [api])

  const refreshSettings = useCallback(async () => {
    try {
      const s = await api.getSettings()
      setSettings({ ...defaultSettings, ...s, weights: { ...DEFAULT_WEIGHTS, ...s.weights }, thresholds: { ...DEFAULT_THRESHOLDS, ...s.thresholds } })
    } catch {
      /* keep defaults */
    }
  }, [api])

  const recheckServer = useCallback(async () => {
    const status = await api.recheckServer()
    setServerStatus(status)
    refreshPending()
    return status
  }, [api, refreshPending])

  const sync = useCallback(async () => {
    const result = await api.syncNow()
    refreshPending()
    if (result.pushed) toast.push({ tone: 'success', title: `${result.pushed} queued change(s) synchronised` })
    if (result.conflicts) {
      toast.push({
        tone: 'warning', title: `${result.conflicts} change(s) need your decision`,
        message: 'The server found a possible duplicate while replaying an offline entry. Open Sync Centre.',
      })
    }
    if (result.failed) toast.push({ tone: 'error', title: `${result.failed} change(s) could not be sent`, message: 'They stay queued and can be retried.' })
    return result
  }, [api, refreshPending, toast])

  // Pre-warm the export modules (xlsx / jsPDF) while the device is idle so
  // the first Export tap never stalls on a chunk fetch over a weak link —
  // the field report where "Export is no longer clickable" was partly a
  // silent, feedback-less stall of exactly this kind.
  useEffect(() => {
    const warm = () => {
      void import('xlsx')
      void import('jspdf')
      void import('jspdf-autotable')
    }
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
    const handle = w.requestIdleCallback ? w.requestIdleCallback(warm, { timeout: 8000 }) : setTimeout(warm, 5000)
    return () => {
      if (w.requestIdleCallback) window.cancelIdleCallback?.(handle as number)
      else clearTimeout(handle as number)
    }
  }, [])

  // boot: restore session, load settings
  useEffect(() => {
    let mounted = true
    ;(async () => {
      await api.ready
      const session = await api.restoreSession()
      if (!mounted) return
      userRef.current = session
      setUser(session)
      setReady(true)
      await refreshSettings()
      refreshPending()
      if (session) {
        void probeConnection()
        void api.refreshMirror().catch(() => undefined)
      }
    })()
    return () => {
      mounted = false
    }
  }, [api, refreshPending, refreshSettings])

  // connection + sync events
  useEffect(() => {
    const offConn = onConnectionChange((state) => {
      setConnection(state)
      if (state === 'online' && userRef.current && api.pendingChanges().length) void sync()
    })
    const offEvent = api.onEvent((e: SyncEvent) => {
      setTick((t) => t + 1)
      refreshPending()
      if (e.type === 'queued') {
        toast.push({
          tone: 'info', title: 'Saved locally — queued for the server',
          message: e.detail ? `${e.detail}. It will sync automatically when the connection returns.` : undefined,
        })
      }
      if (e.type === 'not-provisioned') {
        toast.push({
          tone: 'warning',
          title: 'The municipal database is not set up yet',
          message: 'Your work is saved on this device and will upload automatically once the setup SQL has been run in Supabase.',
        })
      }
      if (e.type === 'storage-warning' && !storageWarned.current) {
        storageWarned.current = true
        toast.push({
          tone: 'warning',
          title: 'Offline copy is incomplete on this device',
          message: 'The browser refused to store the full registry copy (storage quota). Online work is unaffected; offline search on this device may be limited. Free up browser storage or use a device with more space.',
        })
      }
      if (e.type === 'auth-required') {
        toast.push({
          tone: 'warning',
          title: 'Sign in to the municipal server to upload your queue',
          message: 'The server is reachable but does not recognise a session from this device. Your changes are safe here and upload automatically after you sign in.',
        })
      }
    })
    const timer = setInterval(async () => {
      if (!userRef.current) return
      // While the database is missing, re-check occasionally instead of retrying
      // the Queue every minute against a server that cannot accept it.
      if (api.serverStatus === 'missing') {
        const status = await api.recheckServer()
        setServerStatus(status)
        if (status !== 'ready') return
      }
      if (api.pendingChanges().some((p) => p.status !== 'DONE')) void sync()
    }, 60_000)
    const onReconnect = () => void probeConnection()
    window.addEventListener('online', onReconnect)
    return () => {
      offConn()
      offEvent()
      clearInterval(timer)
      window.removeEventListener('online', onReconnect)
    }
  }, [api, refreshPending, sync, toast])

  // session timeout
  useEffect(() => {
    if (!user) return
    /**
     * Prolonging the session writes to storage, so it is throttled: doing that
     * on every keystroke put a synchronous write on the critical path of every
     * letter typed on a low-end phone. The timeout is measured in minutes, so a
     * coarse interval is indistinguishable to the user.
     */
    const TOUCH_INTERVAL_MS = 15_000
    let lastTouch = 0
    const activity = () => {
      const now = Date.now()
      if (now - lastTouch < TOUCH_INTERVAL_MS) return
      lastTouch = now
      api.touchSession()
    }
    const events: Array<keyof WindowEventMap> = ['click', 'keydown', 'mousemove', 'touchstart']
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }))
    const timer = setInterval(() => {
      if (api.sessionExpired()) {
        void api.signOut()
        setUser(null)
        setSessionNotice('Your session expired after a period of inactivity. Please sign in again.')
      }
    }, 30_000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, activity))
      clearInterval(timer)
    }
  }, [api, user])

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api.signIn(email, password)
      if (!res.ok) return { ok: false, error: res.error }
      userRef.current = res.data
      setUser(res.data)
      setSessionNotice(null)
      setNeedsSignIn(false)
      await refreshSettings()
      void api.checkServer(0).then(setServerStatus).catch(() => undefined)
      refreshPending()
      toast.push({ tone: 'success', title: `Welcome, ${res.data.name}`, message: `Signed in as ${res.data.role.replace('_', ' ').toLowerCase()}.` })
      return { ok: true }
    },
    [api, refreshPending, refreshSettings, toast],
  )

  const signOut = useCallback(async () => {
    await api.signOut()
    userRef.current = null
    setUser(null)
  }, [api])

  const value: AppState = {
    api,
    user,
    ready,
    settings,
    connection,
    online: connection !== 'offline',
    usingServer: api.usingServer,
    pendingCount,
    lastSync,
    sessionNotice,
    needsSignIn,
    serverStatus,
    recheckServer,
    signIn,
    signOut,
    refreshSettings,
    sync,
    refreshPending,
  }

  // `tick` intentionally forces a re-render when the outbox changes
  void tick

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

/** Provider-optional variant for shared components (DataTable) that may be
 *  rendered in isolation, e.g. component tests. */
export function useAppOptional(): AppState | null {
  return useContext(AppContext)
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
