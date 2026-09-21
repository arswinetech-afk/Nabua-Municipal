import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import { barangayOverview } from '../lib/analytics'
import type { Barangay, DashboardStats, DataQualityRow, DuplicateCase } from '../lib/types'
import { formatDate, relativeTime, cn, pluralize } from '../lib/utils'
import {
  Badge, Button, Card, IconAlert, IconCopy, IconMap, IconPerson, IconPlus, IconRefresh, IconScroll,
  IconShieldCheck, IconUpload, IconUsers, KpiCard, Progress, Skeleton, StatusBadge, TableSkeleton,
} from '../components/ui'
import { MatchBadge } from '../components/ui'

export default function Dashboard() {
  const { api, user, settings, online, sync, pendingCount } = useApp()
  const navigate = useNavigate()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [cases, setCases] = useState<DuplicateCase[]>([])
  const [quality, setQuality] = useState<DataQualityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [s, b, c, q] = await Promise.all([
        api.dashboardStats(),
        api.listBarangays(true),
        api.listDuplicateCases({ status: 'PENDING', limit: 6 }),
        api.dataQuality(),
      ])
      setStats(s)
      setBarangays(b)
      setCases(c.rows)
      setQuality(q)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, online])

  const attention = stats?.records_requiring_attention ?? 0

  const columns: Array<Column<Barangay>> = [
    {
      key: 'name', header: 'Barangay', value: (b) => b.name,
      render: (b) => (
        <div className="flex items-center gap-2">
          <span className="font-semibold text-ink">{b.name}</span>
          {!b.active && <Badge tone="muted">Inactive</Badge>}
        </div>
      ),
    },
    { key: 'total_members', header: 'Members', value: (b) => b.total_members ?? 0, align: 'right',
      render: (b) => <span className="font-semibold">{(b.total_members ?? 0).toLocaleString()}</span> },
    { key: 'new_today', header: 'New today', value: (b) => b.new_today ?? 0, align: 'right',
      render: (b) => (b.new_today ? <Badge tone="info">+{b.new_today}</Badge> : <span className="text-ink-soft">0</span>) },
    {
      key: 'possible_duplicates', header: 'Possible duplicates', value: (b) => b.possible_duplicates ?? 0, align: 'right',
      render: (b) => (b.possible_duplicates
        ? <Badge tone="danger">{b.possible_duplicates}</Badge>
        : <span className="text-ink-soft">0</span>),
    },
    { key: 'last_updated', header: 'Last update', value: (b) => b.last_updated ?? '',
      render: (b) => <span className="text-xs text-ink-soft">{b.last_updated ? relativeTime(b.last_updated) : '—'}</span> },
    {
      key: 'status', header: 'Status', value: (b) => (b.active ? 'Active' : 'Inactive'),
      render: (b) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={b.active ? 'success' : 'muted'}>{b.active ? 'Active' : 'Inactive'}</Badge>
          {(b.for_review ?? 0) > 0 && <Badge tone="warning">{b.for_review} for review</Badge>}
        </div>
      ),
    },
    {
      key: 'actions', header: 'Quick actions', value: () => '', sortable: false,
      render: (b) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/barangays/${b.id}`)}>Registry</Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/members/new?barangay=${b.id}`)}>Add member</Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/duplicates?barangay=${b.id}`)}>Duplicates</Button>
        </div>
      ),
    },
  ]

  const canEncode = user && ['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)

  return (
    <>
      <PageHeader
        title="Municipal Dashboard"
        subtitle={`Consolidated view of every barangay registry — ${settings.municipality}, ${settings.province}. Last refreshed ${relativeTime(new Date().toISOString())}.`}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={syncing}
              onClick={async () => {
                setSyncing(true)
                await sync()
                await load()
                setSyncing(false)
              }}
            >
              <IconRefresh /> Sync &amp; refresh
            </Button>
            {canEncode && (
              <Button variant="primary" size="sm" onClick={() => navigate('/members/new')}>
                <IconPlus /> Add member
              </Button>
            )}
          </>
        }
      />

      {pendingCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <IconAlert />
          <span><span className="font-semibold">{pendingCount} change(s)</span> are waiting to be sent to the municipal server.</span>
          <Link to="/sync" className="link font-semibold">Open Sync Centre</Link>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loading || !stats ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="card-pad space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-3 w-32" />
            </Card>
          ))
        ) : (
          <>
            <KpiCard label="Total Barangays" value={stats.total_barangays}
              sub={stats.total_barangays > stats.active_barangays
                ? `${stats.active_barangays} active · ${stats.total_barangays - stats.active_barangays} inactive (retired, never deleted)`
                : `${stats.active_barangays} active`}
              icon={<IconMap />} onClick={() => navigate('/barangays')} />
            <KpiCard label="Total Registered Members" value={stats.total_members.toLocaleString()}
              sub={stats.total_members > stats.active_members
                ? `${stats.active_members.toLocaleString()} active · ${(stats.total_members - stats.active_members).toLocaleString()} for review`
                : `${stats.active_members.toLocaleString()} active`} icon={<IconUsers />}
              onClick={() => navigate('/members')} />
            <KpiCard label="New Members Today" value={stats.new_today} sub="Encoded since midnight" icon={<IconPerson />}
              tone={stats.new_today > 0 ? 'success' : 'neutral'} onClick={() => navigate('/members?since=today')} />
            <KpiCard label="Updated Records Today" value={stats.updated_today} sub="Edits recorded in the audit log"
              icon={<IconScroll />} onClick={() => navigate('/audit')} />
            <KpiCard label="Possible Duplicates" value={stats.possible_duplicates} sub="Pairs awaiting a decision"
              tone={stats.possible_duplicates > 0 ? 'danger' : 'success'} icon={<IconCopy />}
              onClick={() => navigate('/duplicates')} />
            <KpiCard label="Duplicate Cases Pending Review" value={stats.pending_duplicate_cases}
              sub="Requires an administrator" tone={stats.pending_duplicate_cases > 0 ? 'warning' : 'success'}
              icon={<IconShieldCheck />} onClick={() => navigate('/duplicates')} />
            <KpiCard label="Records Requiring Attention" value={attention}
              sub={`${stats.archived_records} archived · ${stats.last_sync_at ? 'synced' : 'local data'}`}
              tone={attention > 0 ? 'warning' : 'success'} icon={<IconAlert />}
              onClick={() => navigate('/data-quality')} />
            <KpiCard label="Transfers This Year" value={stats.transferred_this_year ?? 0}
              sub="Residents who changed barangay" icon={<IconRefresh />} />
          </>
        )}
      </div>

      {/* Duplicate watchlist + attention summary */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="card-header">
            <div>
              <h2 className="section-title">Barangay Overview</h2>
              <p className="mt-0.5 text-xs text-ink-soft">Click a barangay to open its member registry.</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => navigate('/barangays')}>View directory</Button>
          </div>
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : (
            <DataTable
              rows={barangays.sort((a, b) => (b.total_members ?? 0) - (a.total_members ?? 0))}
              columns={columns}
              rowKey={(b) => b.id}
              onRowClick={(b) => navigate(`/barangays/${b.id}`)}
              total={barangays.length}
              limit={50}
              dense
              exportName="barangay-overview"
            />
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="card-header">
              <h2 className="section-title">Awaiting review</h2>
              <Button size="sm" variant="secondary" onClick={() => navigate('/duplicates')}>Open centre</Button>
            </div>
            <div className="divide-y divide-line">
              {loading && <div className="space-y-2 p-4"><Skeleton /><Skeleton /><Skeleton /></div>}
              {!loading && cases.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-ink-soft">
                  No duplicate cases are waiting. The registry is clean.
                </p>
              )}
              {cases.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(`/duplicates?case=${c.id}`)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-ink">
                      {c.person_a ? `${c.person_a.first_name} ${c.person_a.last_name}` : 'Record A'}
                      <span className="text-ink-soft"> vs </span>
                      {c.person_b ? `${c.person_b.first_name} ${c.person_b.last_name}` : 'Record B'}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-ink-soft">
                      {c.person_a?.barangay_name ?? '—'} · {relativeTime(c.created_at)}
                    </span>
                  </span>
                  <MatchBadge band={c.match_band} score={c.match_score} />
                </button>
              ))}
            </div>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title">Data completeness</h2>
            <div className="mt-3 space-y-4">
              {[
                { id: 'missing_birthdate', label: 'Birthdates recorded', hint: 'Records without a birthdate weaken duplicate detection.' },
                { id: 'missing_sex', label: 'Sex recorded', hint: 'Sex is one of the matching fields.' },
                { id: 'incomplete_address', label: 'Addresses complete', hint: 'Address and purok/sitio improve match confidence.' },
                { id: 'invalid_contact', label: 'Contact numbers valid', hint: 'Numbers shorter than 7 digits cannot be used for matching or contacting.' },
              ].map((row) => {
                const missing = quality.find((q) => q.id === row.id)?.count ?? 0
                const total = stats?.total_members ?? 0
                return (
                  <CompletenessRow
                    key={row.id}
                    label={row.label}
                    value={Math.max(0, total - missing)}
                    total={total}
                    hint={`${missing.toLocaleString()} record(s) need attention. ${row.hint}`}
                  />
                )
              })}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button size="sm" variant="secondary" onClick={() => navigate('/data-quality')}>Data Quality</Button>
              {user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role) ? (
                <Button size="sm" variant="secondary" onClick={() => navigate('/imports')}>
                  <IconUpload /> Import file
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => navigate('/reports')}>Reports</Button>
              )}
            </div>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title">Status distribution</h2>
            <div className="mt-3 space-y-2 text-xs">
              {[
                ['Active', stats?.active_members ?? 0, 'success'],
                ['For review', Math.max(0, (stats?.total_members ?? 0) - (stats?.active_members ?? 0)), 'warning'],
                ['Archived / merged', (stats?.archived_records ?? 0), 'muted'],
              ].map(([label, value, tone]) => (
                <div key={String(label)} className="flex items-center justify-between gap-3">
                  <span className="text-ink-soft">{label}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{Number(value).toLocaleString()}</span>
                    <StatusBadge status={String(label).toUpperCase().replace(/ /g, '_')} />
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <p className="mt-4 text-[11px] text-ink-soft">
        {pluralize(stats?.total_members ?? 0, 'master record')} across {stats?.total_barangays ?? 0} barangays.
        Duplicate prevention is enforced at the database level; encoders are warned before saving.
      </p>
    </>
  )
}

function CompletenessRow({ label, value, total, hint }: { label: string; value: number; total: number; hint: string }) {
  const pct = total ? (value / total) * 100 : 0
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className={cn('font-semibold', pct > 95 ? 'text-emerald-700' : pct > 80 ? 'text-amber-700' : 'text-red-700')}>
          {Math.round(pct)}%
        </span>
      </div>
      <div className="mt-1.5"><Progress value={pct} tone={pct > 95 ? 'success' : pct > 80 ? 'warning' : 'danger'} /></div>
      <p className="mt-1 text-[11px] text-ink-soft">{hint}</p>
    </div>
  )
}
