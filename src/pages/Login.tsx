import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { SUPABASE_ENABLED, SUPABASE_URL } from '../lib/supabase'
import { Button, Card, Field, IconAlert, IconShieldCheck, IconWifiOff, useToast } from '../components/ui'

const DEMO_ACCOUNTS = [
  { role: 'System Administrator', email: 'admin@nabua.gov.ph', password: 'Admin@NMBR2026' },
  { role: 'Administrator', email: 'maria.santos@nabua.gov.ph', password: 'Admin@NMBR2026' },
  { role: 'Encoder', email: 'pedro.reyes@nabua.gov.ph', password: 'Encoder@2026' },
  { role: 'Viewer', email: 'viewer@nabua.gov.ph', password: 'Viewer@2026' },
]

/**
 * The demonstration accounts (with their passwords) are a training aid, not a
 * production feature: a published municipal sign-in page must not print
 * credentials. They appear only in development builds, or in a bundle built
 * on purpose with VITE_SHOW_DEMO_ACCOUNTS=true (see docs/GO_LIVE.md).
 */
const SHOW_DEMO_ACCOUNTS =
  import.meta.env.DEV || (import.meta.env.VITE_SHOW_DEMO_ACCOUNTS as string | undefined) === 'true'

export default function Login() {
  const { signIn, user, online, pendingCount, api, serverStatus } = useApp()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  /**
   * `?reauth=1`: the device already has an on-device session but the municipal
   * server needs its own sign-in before the queued work can upload. The form
   * is shown anyway, with an explanation of what the sign-in unlocks.
   */
  const reauth = params.get('reauth') === '1'
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (user && !reauth) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await signIn(email, password)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Sign in failed.')
      return
    }
    if (api.signInNotice) {
      toast.push({ tone: 'warning', title: 'Working from the on-device registry', message: api.signInNotice })
    } else if (reauth) {
      toast.push({
        tone: 'success', title: 'Connected to the municipal server',
        message: pendingCount > 0
          ? `Signed in — your ${pendingCount} queued change(s) are uploading now.`
          : 'Signed in to the municipal server.',
      })
    } else {
      toast.push({ tone: 'success', title: 'Signed in' })
    }
    navigate('/', { replace: true })
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas lg:flex-row">
      {/* Institutional panel */}
      <div className="flex flex-col justify-between bg-gov-950 px-6 py-8 text-white lg:w-[46%] lg:px-12 lg:py-12">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-white/12 text-base font-bold">NM</span>
            <div>
              <p className="text-sm font-semibold">NMBR</p>
              <p className="text-xs text-gov-100/70">Nabua Municipal Barangay Registry</p>
            </div>
          </div>
          <h1 className="mt-8 text-2xl leading-snug font-bold lg:text-3xl">
            Centralized Member Registry &amp; Duplicate Prevention System
          </h1>
          <p className="mt-3 max-w-lg text-sm text-gov-100/80">
            One master record per resident across every barangay of Nabua, Camarines Sur. Encoders are warned about
            existing members <span className="font-semibold text-white">before</span> a record is created, and the
            database refuses simultaneous duplicates outright.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-gov-100/85">
            {[
              'Fuzzy duplicate detection with an explanation of every match',
              'Database-level identity guard — proven against simultaneous submissions',
              'Barangay transfer history without creating a second person record',
              'Full audit trail of every add, edit, transfer, merge and import',
              'Works offline; queued work synchronises automatically',
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <IconShieldCheck className="mt-0.5 h-4 w-4 text-gov-200" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-8 text-[11px] text-gov-100/60">
          Data privacy: this system processes personal information under RA 10173. All access is logged.
        </p>
      </div>

      {/* Sign in form */}
      <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8">
        <div className="w-full max-w-md">
          <Card className="card-pad">
            <h2 className="text-base font-bold text-ink">
              {reauth ? 'Sign in to the municipal server' : 'Office sign in'}
            </h2>
            <p className="mt-1 text-xs text-ink-soft">
              {!online
                ? 'No connection detected — sign in with your office credentials to continue offline.'
                : serverStatus === 'missing'
                  ? 'The server is reachable but its database has not been created yet, so the registry runs on this device. Ask the system administrator to run the setup SQL.'
                  : SUPABASE_ENABLED
                    ? 'The municipal server is reachable. If it cannot be reached again mid-shift, work continues on the on-device registry copy.'
                    : 'Running in standalone registry mode (no server configured).'}
            </p>

            {!online && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <IconWifiOff className="mt-0.5" />
                <span>
                  Offline mode. Records you create are stored on this device and synchronised when the connection returns
                  {pendingCount > 0 ? ` (${pendingCount} change(s) already queued)` : ''}.
                </span>
              </div>
            )}

            {reauth && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                <IconAlert className="mt-0.5" />
                <span>
                  This device is working from its on-device registry copy, and the municipal server does not
                  recognise a session from it — that is why queued changes are waiting. Sign in with your office
                  account to reconnect
                  {pendingCount > 0 ? ` and upload your ${pendingCount} queued change(s)` : ''}. Your local work
                  is kept either way.
                </span>
              </div>
            )}

            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800" role="alert">
                <IconAlert className="mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form className="mt-4 space-y-3" onSubmit={submit}>
              <Field label="Official email address" required>
                <input
                  className="input"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@nabua.gov.ph"
                />
              </Field>
              <Field label="Password" required>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </Field>
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                Sign in
              </Button>
            </form>

            {SHOW_DEMO_ACCOUNTS && (
              <div className="mt-4 rounded-md border border-line bg-slate-50 p-3">
                <p className="text-[11px] font-semibold text-ink-soft uppercase">Demonstration accounts</p>
                <ul className="mt-2 space-y-1.5">
                  {DEMO_ACCOUNTS.map((a) => (
                    <li key={a.email} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <span className="font-medium text-ink">{a.role}</span>
                      <button
                        type="button"
                        className="link mono text-left"
                        onClick={() => {
                          setEmail(a.email)
                          setPassword(a.password)
                        }}
                      >
                        {a.email} · {a.password}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[10px] text-ink-soft">
                  Training build only. Click an account to fill the form; production bundles never print
                  credentials (see docs/GO_LIVE.md).
                </p>
              </div>
            )}
          </Card>

          {/* Infrastructure detail: useful while training or debugging, but a
              published municipal sign-in page should not advertise its
              backend hostname. Kept for development/training bundles only;
              staff can still see it under Settings → Municipal server. */}
          {SHOW_DEMO_ACCOUNTS && (
            <p className="mt-4 text-center text-[11px] text-ink-soft">
              Server: <span className="mono">{SUPABASE_URL.replace('https://', '')}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
