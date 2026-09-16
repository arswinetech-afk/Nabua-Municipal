import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { MemberTable } from '../components/MemberTable'
import type { Barangay, Person, PersonStatus } from '../lib/types'
import { PERSON_STATUSES } from '../lib/types'
import {
  Badge, Button, Card, IconCopy, IconPlus, IconRefresh, IconSearch, IconUpload, KpiCard,
} from '../components/ui'

type AttentionKey = '' | 'missing_birthdate' | 'missing_sex' | 'invalid_contact' | 'incomplete_address' | 'duplicate_contact' | 'same_name_different_dob'

const ATTENTION: Array<{ key: AttentionKey; label: string }> = [
  { key: '', label: 'No extra filter' },
  { key: 'missing_birthdate', label: 'Missing birthdate' },
  { key: 'missing_sex', label: 'Missing sex' },
  { key: 'invalid_contact', label: 'Invalid contact number' },
  { key: 'duplicate_contact', label: 'Duplicate contact number' },
  { key: 'incomplete_address', label: 'Incomplete address' },
]

/** Local-calendar date (YYYY-MM-DD) of today, for the "since midnight" filter. */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function Members() {
  const { api, user, settings, online } = useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const [rows, setRows] = useState<Person[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [debounced, setDebounced] = useState(query)
  const [barangayId, setBarangayId] = useState(params.get('barangay') ?? '')
  const [status, setStatus] = useState(params.get('status') ?? 'ALL')
  const [attention, setAttention] = useState<AttentionKey>((params.get('attention') as AttentionKey) ?? '')
  const [duplicatesOnly, setDuplicatesOnly] = useState(params.get('duplicates') === '1')
  // "Encoded since midnight" — set by the New-today cards on the directory
  // and dashboard so the list matches the number on the card.
  const [sinceToday, setSinceToday] = useState(params.get('since') === 'today')
  const [sort, setSort] = useState<'name' | 'updated' | 'dob'>('name')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [limit, setLimit] = useState(25)
  const [offset, setOffset] = useState(0)
  const [summary, setSummary] = useState({ total: 0, active: 0, review: 0, dupes: 0 })

  const canEncode = user && ['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)

  useEffect(() => {
    const handle = setTimeout(() => { setDebounced(query.trim()); setOffset(0) }, 300)
    return () => clearTimeout(handle)
  }, [query])

  useEffect(() => {
    void api.listBarangays().then(setBarangays)
  }, [api])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.searchPersons({
        query: debounced || undefined,
        barangay_id: barangayId || null,
        status: status === 'ALL' ? null : status,
        attention: attention || null,
        duplicates_only: duplicatesOnly,
        created_since: sinceToday ? localToday() : null,
        sort, dir, limit, offset,
      })
      setRows(res.rows)
      setTotal(res.total)
      const stats = await api.dashboardStats()
      setSummary({
        total: stats.total_members,
        active: stats.active_members,
        review: Math.max(0, stats.total_members - stats.active_members),
        dupes: stats.possible_duplicates,
      })
    } finally {
      setLoading(false)
    }
  }, [api, debounced, barangayId, status, attention, duplicatesOnly, sinceToday, sort, dir, limit, offset])

  useEffect(() => {
    void load()
  }, [load, online])

  // keep filters shareable / bookmarkable
  useEffect(() => {
    const next = new URLSearchParams()
    if (debounced) next.set('q', debounced)
    if (barangayId) next.set('barangay', barangayId)
    if (status !== 'ALL') next.set('status', status)
    if (attention) next.set('attention', attention)
    if (duplicatesOnly) next.set('duplicates', '1')
    if (sinceToday) next.set('since', 'today')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, barangayId, status, attention, duplicatesOnly, sinceToday])

  const activeFilters = [debounced, barangayId, status !== 'ALL' ? status : '', attention, duplicatesOnly ? 'duplicates' : '', sinceToday ? 'since' : '']
    .filter(Boolean).length

  return (
    <>
      <PageHeader
        title="Member Registry"
        subtitle="Every resident in the municipality lives in one master registry. Filter by barangay, status or data-quality issue, and open a record to edit, transfer or review duplicates."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}>
              <IconRefresh /> Refresh
            </Button>
            {canEncode && (
              <Button variant="primary" size="sm" onClick={() => navigate('/members/new')}>
                <IconPlus /> Add member
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Master records" value={summary.total.toLocaleString()} sub={`${summary.active.toLocaleString()} active`} />
        <KpiCard label="For review" value={summary.review.toLocaleString()} sub="Status other than active"
          tone={summary.review ? 'warning' : 'success'} />
        <KpiCard label="Possible duplicates" value={summary.dupes} sub="Awaiting a decision"
          tone={summary.dupes ? 'danger' : 'success'} onClick={() => navigate('/duplicates')} />
        <KpiCard label="Filtered results" value={total.toLocaleString()} sub={activeFilters ? `${activeFilters} filter(s) applied` : 'No filters applied'} />
      </div>

      <Card className="card-pad mt-4 no-print">
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <IconSearch className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-slate-400" />
            <input
              className="input pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, birthdate, contact number, purok or reference number"
              aria-label="Search the municipal registry"
            />
          </div>
          <select className="input max-w-[12rem]" value={barangayId} onChange={(e) => { setBarangayId(e.target.value); setOffset(0) }}
            aria-label="Filter by barangay">
            <option value="">All barangays</option>
            {barangays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className="input max-w-[11rem]" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0) }}
            aria-label="Filter by status">
            <option value="ALL">All statuses</option>
            {PERSON_STATUSES.map((s: PersonStatus) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <select className="input max-w-[14rem]" value={attention} onChange={(e) => { setAttention(e.target.value as AttentionKey); setOffset(0) }}
            aria-label="Filter by data quality issue">
            {ATTENTION.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
          <select className="input max-w-[10rem]" value={`${sort}:${dir}`}
            onChange={(e) => { const [s, d] = e.target.value.split(':'); setSort(s as typeof sort); setDir(d as 'asc' | 'desc') }}>
            <option value="name:asc">Name A → Z</option>
            <option value="name:desc">Name Z → A</option>
            <option value="updated:desc">Recently updated</option>
            <option value="dob:asc">Birthdate ↑</option>
            <option value="dob:desc">Birthdate ↓</option>
          </select>
          <select className="input max-w-[7.5rem]" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0) }}>
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-medium text-ink">
            <input type="checkbox" checked={duplicatesOnly} onChange={(e) => { setDuplicatesOnly(e.target.checked); setOffset(0) }} />
            Only records with open duplicate cases
          </label>
          <label className="flex items-center gap-2 text-xs font-medium text-ink">
            <input type="checkbox" checked={sinceToday} onChange={(e) => { setSinceToday(e.target.checked); setOffset(0) }} />
            Encoded since midnight
          </label>
          {activeFilters > 0 && (
            <>
              <Badge tone="info">{activeFilters} filter(s)</Badge>
              <Button size="sm" variant="ghost"
                onClick={() => { setQuery(''); setBarangayId(''); setStatus('ALL'); setAttention(''); setDuplicatesOnly(false); setSinceToday(false); setOffset(0) }}>
                Clear all
              </Button>
            </>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => navigate('/duplicates')}>
              <IconCopy /> Duplicate Center
            </Button>
            {user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role) && (
              <Button size="sm" variant="secondary" onClick={() => navigate('/imports')}>
                <IconUpload /> Import members
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="mt-4">
        <MemberTable
          rows={rows}
          total={total}
          loading={loading}
          limit={limit}
          offset={offset}
          onPage={setOffset}
          onRowClick={(p) => navigate(`/members/${p.id}`)}
          exportName="member-registry"
          exportTitle="Municipal Member Registry"
          maskContactNumbers={settings.mask_contact_in_lists}
          emptyTitle="No members match these filters"
          emptyMessage="Try removing a filter, searching a different spelling, or add the member as a new record."
          emptyAction={canEncode
            ? <Button variant="primary" size="sm" onClick={() => navigate('/members/new')}><IconPlus /> Add member</Button>
            : undefined}
        />
      </div>

      <p className="mt-3 text-[11px] text-ink-soft">
        Search covers names, birthdates, contact numbers, purok/sitio and reference numbers across all barangays.
        Contact numbers are {settings.mask_contact_in_lists ? 'masked' : 'shown in full'} in list views to protect resident privacy.
      </p>
    </>
  )
}
