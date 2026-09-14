import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { cn, formatDateTime, initials, relativeTime } from '../lib/utils'
import { applyAppUpdate, useAppUpdate } from '../lib/pwa'
import { useApp } from '../state/AppProvider'
import { ROLE_LABEL, type UserRole } from '../lib/types'
import {
  Badge, Button, IconAlert, IconChart, IconCloud, IconCog, IconCopy, IconDashboard, IconLogout, IconMap,
  IconMenu, IconScroll, IconShieldCheck, IconUpload, IconUsers, IconWifiOff, IconClose, IconRefresh,
} from './ui'

type NavItem = { to: string; label: string; icon: ReactNode; roles?: UserRole[]; end?: boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <IconDashboard />, end: true },
  { to: '/barangays', label: 'Barangays', icon: <IconMap /> },
  { to: '/members', label: 'Members', icon: <IconUsers /> },
  { to: '/duplicates', label: 'Duplicate Center', icon: <IconCopy /> },
  { to: '/data-quality', label: 'Data Quality', icon: <IconShieldCheck /> },
  { to: '/imports', label: 'Imports', icon: <IconUpload />, roles: ['ADMINISTRATOR', 'SYSTEM_ADMIN'] },
  { to: '/audit', label: 'Audit Logs', icon: <IconScroll />, roles: ['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'] },
  { to: '/reports', label: 'Reports', icon: <IconChart />, roles: ['ADMINISTRATOR', 'SYSTEM_ADMIN', 'VIEWER'] },
  { to: '/users', label: 'Users', icon: <IconUsers />, roles: ['SYSTEM_ADMIN', 'ADMINISTRATOR'] },
  { to: '/settings', label: 'Settings', icon: <IconCog />, roles: ['SYSTEM_ADMIN'] },
]

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useApp()
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 py-3" aria-label="Main navigation">
      {NAV.filter((item) => !item.roles || (user && item.roles.includes(user.role))).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-white/12 text-white' : 'text-gov-100/80 hover:bg-white/8 hover:text-white',
            )
          }
        >
          {item.icon}
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

function ConnectionPill() {
  const { connection, pendingCount, sync, online } = useApp()
  const [busy, setBusy] = useState(false)
  const label = !online ? 'Offline' : 'Connected'
  const tone = !online ? 'bg-amber-500/20 text-amber-100 ring-amber-300/30' : 'bg-emerald-500/20 text-emerald-100 ring-emerald-300/30'
  return (
    <button
      type="button"
      onClick={async () => {
        setBusy(true)
        await sync()
        setBusy(false)
      }}
      title={online ? 'Connected to the municipal server — click to synchronise queued work' : 'Working offline — queued work will sync automatically'}
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset', tone)}
    >
      {online ? <IconCloud className="h-3.5 w-3.5" /> : <IconWifiOff className="h-3.5 w-3.5" />}
      {label}
      {pendingCount > 0 && <span className="rounded bg-white/20 px-1.5">{pendingCount} queued</span>}
      {busy && <IconRefresh className="h-3.5 w-3.5 animate-spin" />}
    </button>
  )
}

export default function Layout() {
  const { user, signOut, pendingCount, online, lastSync, sessionNotice, settings } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const [drawer, setDrawer] = useState(false)
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    setDrawer(false)
    setMenu(false)
  }, [location.pathname])

  if (!user) return null

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* ---------------- desktop sidebar ---------------- */}
      <aside className="no-print hidden w-64 shrink-0 flex-col bg-gov-950 lg:flex">
        <Link to="/" className="flex items-center gap-3 px-4 py-4 text-white">
          <span className="flex h-9 w-9 items-center justify-center rounded bg-white/12 text-sm font-bold">NM</span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold">NMBR</span>
            <span className="block text-[11px] text-gov-100/70">Nabua · Camarines Sur</span>
          </span>
        </Link>
        <NavLinks />
        <div className="border-t border-white/10 px-4 py-3 text-[11px] text-gov-100/70">
          <p className="font-semibold text-gov-100">One person = one master record</p>
          <p className="mt-1">Duplicate prevention is enforced in the database.</p>
        </div>
      </aside>

      {/* ---------------- mobile drawer ---------------- */}
      {drawer && (
        <div className="no-print fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawer(false)} />
          <div className="animate-rise absolute inset-y-0 left-0 flex w-72 flex-col bg-gov-950">
            <div className="flex items-center justify-between px-4 py-4 text-white">
              <span className="text-sm font-semibold">NMBR Navigation</span>
              <button onClick={() => setDrawer(false)} aria-label="Close navigation" className="btn btn-ghost btn-sm text-white">
                <IconClose />
              </button>
            </div>
            <NavLinks onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---------------- top bar ---------------- */}
        <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-white/95 px-3 py-2.5 backdrop-blur sm:px-5">
          <button className="btn btn-ghost btn-sm lg:hidden" onClick={() => setDrawer(true)} aria-label="Open navigation">
            <IconMenu />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">Nabua Municipal Barangay Registry</p>
            <p className="hidden text-[11px] text-ink-soft sm:block">
              Centralized Member Registry &amp; Duplicate Prevention System
            </p>
          </div>
          <ConnectionPill />
          <div className="relative">
            <button
              onClick={() => setMenu((m) => !m)}
              className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 hover:bg-slate-50"
              aria-haspopup="menu"
              aria-expanded={menu}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gov-900 text-[11px] font-bold text-white">
                {initials(user.name)}
              </span>
              <span className="hidden text-left sm:block">
                <span className="block max-w-[10rem] truncate text-xs font-semibold">{user.name}</span>
                <span className="block text-[10px] text-ink-soft">{ROLE_LABEL[user.role]}</span>
              </span>
            </button>
            {menu && (
              <div role="menu" className="animate-fade absolute right-0 mt-2 w-64 rounded-md border border-line bg-white p-3 shadow-lg">
                <p className="text-xs font-semibold text-ink">{user.name}</p>
                <p className="text-[11px] break-all text-ink-soft">{user.email}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge tone="info">{ROLE_LABEL[user.role]}</Badge>
                  {!online && <Badge tone="warning">Offline mode</Badge>}
                </div>
                <p className="mt-2 text-[11px] text-ink-soft">Last sync: {lastSync ? formatDateTime(lastSync) : 'not yet'}</p>
                <Link to="/sync" className="btn btn-secondary btn-sm mt-3 w-full" onClick={() => setMenu(false)}>
                  Sync Centre {pendingCount > 0 && <Badge tone="warning">{pendingCount}</Badge>}
                </Link>
                <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => void signOut().then(() => navigate('/login'))}>
                  <IconLogout /> Sign out
                </Button>
              </div>
            )}
          </div>
        </header>

        <AppUpdateBar />

        {sessionNotice && (
          <div className="no-print flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:px-5">
            <IconAlert /> {sessionNotice}
          </div>
        )}

        {!online && (
          <div className="no-print flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:px-5">
            <IconWifiOff />
            <span className="font-semibold">Working offline.</span>
            <span>
              Duplicate checking, search and encoding keep working from the local registry copy.
              {pendingCount > 0 ? ` ${pendingCount} change(s) are queued and will sync automatically.` : ''}
            </span>
            <Link to="/sync" className="link font-semibold">View queue</Link>
          </div>
        )}

        <main className="min-w-0 flex-1 px-3 py-4 sm:px-5 sm:py-6">
          <Outlet />
        </main>

        <footer className="no-print border-t border-line px-3 py-3 text-[11px] text-ink-soft sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Municipality of {settings.municipality}, {settings.province} · Republic of the Philippines
            </span>
            <span>
              Personal data is protected under RA 10173 (Data Privacy Act). Access is logged.
            </span>
          </div>
        </footer>
      </div>
    </div>
  )
}

/** Compact page header used by every screen. */
export function PageHeader({
  title, subtitle, actions, breadcrumbs,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  breadcrumbs?: Array<{ label: string; to?: string }>
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="mb-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-soft" aria-label="Breadcrumb">
            {breadcrumbs.map((b, i) => (
              <span key={`${b.label}-${i}`} className="flex items-center gap-1">
                {b.to ? <Link className="link" to={b.to}>{b.label}</Link> : <span>{b.label}</span>}
                {i < breadcrumbs.length - 1 && <span aria-hidden="true">/</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-lg font-bold tracking-tight text-ink sm:text-xl">{title}</h1>
        {subtitle && <p className="mt-0.5 max-w-3xl text-xs text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function relativeSyncLabel(iso: string | null): string {
  return iso ? relativeTime(iso) : 'never'
}

/**
 * Shown when a newly deployed build has taken over from the one this page is
 * running. Nothing reloads on its own: an encoder may be part-way through a form
 * and losing it to an automatic refresh would be worse than the stale screen.
 */
function AppUpdateBar() {
  const ready = useAppUpdate()
  const [dismissed, setDismissed] = useState(false)
  if (!ready || dismissed) return null
  return (
    <div className="no-print flex flex-wrap items-center gap-2 border-b border-gov-200 bg-gov-50 px-3 py-2 text-xs text-gov-900 sm:px-5">
      <IconRefresh />
      <span className="font-semibold">A newer version of NMBR is ready.</span>
      <span className="text-gov-800">Reload to use it — anything you have saved is already on this device.</span>
      <button className="btn btn-primary btn-sm ml-auto" onClick={applyAppUpdate}>Reload now</button>
      <button className="btn btn-ghost btn-sm" onClick={() => setDismissed(true)}>Later</button>
    </div>
  )
}
