import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import NotFound from './pages/NotFound'
import { useApp } from './state/AppProvider'
import { Card, IconShieldCheck, Skeleton } from './components/ui'
import type { UserRole } from './lib/types'
import { ROLE_LABEL } from './lib/types'

/* Heavier screens are split out so the registry opens fast on slow connections. */
const Barangays = lazy(() => import('./pages/Barangays'))
const BarangayRegistry = lazy(() => import('./pages/BarangayRegistry'))
const Members = lazy(() => import('./pages/Members'))
const AddMember = lazy(() => import('./pages/AddMember'))
const MemberProfile = lazy(() => import('./pages/MemberProfile'))
const DuplicateCenter = lazy(() => import('./pages/DuplicateCenter'))
const Subsidies = lazy(() => import('./pages/Subsidies'))
const DataQuality = lazy(() => import('./pages/DataQuality'))
const Imports = lazy(() => import('./pages/Imports'))
const AuditLogs = lazy(() => import('./pages/AuditLogs'))
const Reports = lazy(() => import('./pages/Reports'))
const Users = lazy(() => import('./pages/Users'))
const Settings = lazy(() => import('./pages/Settings'))
const SyncCentre = lazy(() => import('./pages/SyncCentre'))

export default function App() {
  const { ready, user } = useApp()

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <Card className="card-pad w-full max-w-sm space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-8 w-full" />
          <p className="text-[11px] text-ink-soft">Opening the Nabua Municipal Barangay Registry…</p>
        </Card>
      </div>
    )
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* Everything below requires an authenticated office account. */}
        <Route
          element={
            <Protected>
              <Layout />
            </Protected>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/barangays" element={<Barangays />} />
          <Route path="/barangays/:id" element={<BarangayRegistry />} />
          <Route path="/members" element={<Members />} />
          <Route path="/members/new" element={<RequireRole roles={['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN']}><AddMember /></RequireRole>} />
          <Route path="/members/:id" element={<MemberProfile />} />
          <Route path="/subsidies" element={<Subsidies />} />
          <Route path="/duplicates" element={<DuplicateCenter />} />
          <Route path="/data-quality" element={<DataQuality />} />
          <Route path="/imports" element={<RequireRole roles={['ADMINISTRATOR', 'SYSTEM_ADMIN']}><Imports /></RequireRole>} />
          <Route path="/audit" element={<AuditLogs />} />
          <Route path="/reports" element={<RequireRole roles={['ADMINISTRATOR', 'SYSTEM_ADMIN', 'VIEWER']}><Reports /></RequireRole>} />
          <Route path="/users" element={<RequireRole roles={['SYSTEM_ADMIN', 'ADMINISTRATOR']}><Users /></RequireRole>} />
          <Route path="/settings" element={<RequireRole roles={['SYSTEM_ADMIN']}><Settings /></RequireRole>} />
          <Route path="/sync" element={<SyncCentre />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

function Protected({ children }: { children: ReactNode }) {
  const { user } = useApp()
  const location = useLocation()
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

/**
 * Server-side authorisation is authoritative. This only avoids showing a screen
 * the signed-in role cannot use; the database refuses the call as well.
 */
function RequireRole({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  const { user } = useApp()
  if (!user) return <Navigate to="/login" replace />
  if (!roles.includes(user.role)) {
    return (
      <Card className="card-pad mx-auto max-w-xl text-center">
        <IconShieldCheck className="mx-auto h-8 w-8 text-amber-600" />
        <h1 className="mt-2 text-base font-bold text-ink">Not available for your account</h1>
        <p className="mt-1 text-xs text-ink-soft">
          You are signed in as <span className="font-semibold text-ink">{ROLE_LABEL[user.role]}</span>. This screen is
          limited to: {roles.map((r) => ROLE_LABEL[r]).join(', ')}. The database enforces the same rule, so no data is
          exposed even if the screen were reached.
        </p>
      </Card>
    )
  }
  return <>{children}</>
}

function RouteFallback() {
  return (
    <div className="mx-auto max-w-4xl space-y-3 p-6">
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-3 w-80" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
      <Skeleton className="h-64" />
    </div>
  )
}
