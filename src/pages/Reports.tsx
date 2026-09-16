import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import type { Barangay, PersonIndexRow } from '../lib/types'
import { formatDate, relativeTime, downloadXlsx } from '../lib/utils'
import { fullName } from '../lib/normalize'
import {
  Badge, Button, Card, Field, IconAlert, IconChart, IconDownload, IconPrint, IconRefresh, KpiCard,
  MatchBadge, Progress, Skeleton, StatusBadge,
} from '../components/ui'

type Kind =
  | 'by_barangay' | 'by_sex' | 'by_age_group' | 'new_members' | 'transferred'
  | 'possible_duplicates' | 'resolved_duplicates' | 'data_quality' | 'encoder_activity' | 'audit_summary'

const REPORTS: Array<{ kind: Kind; label: string; description: string }> = [
  { kind: 'by_barangay', label: 'Members by barangay', description: 'Totals, new registrations, sex split and duplicates per barangay.' },
  { kind: 'by_sex', label: 'Members by sex', description: 'Male / female distribution across the filtered scope.' },
  { kind: 'by_age_group', label: 'Members by age group', description: 'Children, youth, adults and senior citizens.' },
  { kind: 'new_members', label: 'Newly registered members', description: 'Records created inside the selected period.' },
  { kind: 'transferred', label: 'Barangay transfers', description: 'Residents who changed barangay, with the reason given.' },
  { kind: 'possible_duplicates', label: 'Possible duplicates', description: 'Duplicate pairs still awaiting a decision.' },
  { kind: 'resolved_duplicates', label: 'Resolved duplicates', description: 'Cases closed as merged, different people or kept both.' },
  { kind: 'data_quality', label: 'Data quality', description: 'Records needing correction, by category.' },
  { kind: 'encoder_activity', label: 'Encoder / administrator activity', description: 'How many records each staff member created, edited, transferred or merged.' },
  { kind: 'audit_summary', label: 'Audit summary', description: 'Counts of every recorded action in the period.' },
]

type ReportRow = Record<string, unknown>

export default function Reports() {
  const { api, user } = useApp()
  const navigate = useNavigate()

  const [kind, setKind] = useState<Kind>('by_barangay')
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [barangayId, setBarangayId] = useState('')
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [data, setData] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.listBarangays(true).then(setBarangays)
  }, [api])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.reports(kind, { from, to, barangay_id: barangayId || undefined })
      setData((Array.isArray(result) ? result : []) as ReportRow[])
    } catch (err) {
      setError((err as Error).message)
      setData([])
    } finally {
      setLoading(false)
    }
  }, [api, kind, from, to, barangayId])

  useEffect(() => {
    void load()
  }, [load])

  const active = REPORTS.find((r) => r.kind === kind)!
  const columns = columnsFor(kind, navigate)
  const totals = summarise(kind, data)

  return (
    <>
      <PageHeader
        title="Reports & Analytics"
        subtitle="Municipal reports for submission by the barangay, the municipal hall or an auditor. Every report can be printed as a PDF or exported to CSV."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}><IconRefresh /> Re-run</Button>
            <Button variant="secondary" size="sm" onClick={() => exportRows(kind, data)}><IconDownload /> Export Excel</Button>
            <Button variant="primary" size="sm" onClick={() => window.print()}><IconPrint /> Print / PDF</Button>
          </>
        }
      />

      <Card className="card-pad mb-4 no-print">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Report">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {REPORTS.map((r) => <option key={r.kind} value={r.kind}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="From">
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Barangay">
            <select className="input" value={barangayId} onChange={(e) => setBarangayId(e.target.value)}>
              <option value="">All barangays</option>
              {barangays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        <p className="mt-3 text-xs text-ink-soft">{active.description}</p>
      </Card>

      <div className="mb-4">
        <div className="mb-3 hidden items-center justify-between gap-2 print:flex">
          <div>
            <h1 className="text-lg font-bold">Nabua Municipal Barangay Registry</h1>
            <p className="text-xs">
              {active.label} · {formatDate(from)} to {formatDate(to)} · {barangays.find((b) => b.id === barangayId)?.name ?? 'All barangays'}
            </p>
          </div>
          <p className="text-[11px]">Generated {formatDate(new Date().toISOString())} by {user?.name}</p>
        </div>

        {kind === 'by_barangay' && (
          <div className="no-print grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Total members" value={totals.total.toLocaleString()} sub="In the selected scope" />
            <KpiCard label="Barangays covered" value={data.length} sub={barangayId ? '1 selected' : 'All barangays'} />
            <KpiCard label="New in period" value={totals.newInPeriod.toLocaleString()} sub={`${formatDate(from)} → ${formatDate(to)}`} tone="success" />
            <KpiCard label="Possible duplicates" value={totals.duplicates.toLocaleString()} sub="Open cases affecting these barangays" tone={totals.duplicates ? 'warning' : 'success'} />
          </div>
        )}

        {kind === 'by_age_group' && (
          <div className="no-print grid grid-cols-2 gap-3 lg:grid-cols-4">
            {data.slice(0, 4).map((r) => (
              <KpiCard key={String(r.group)} label={String(r.group)} value={Number(r.total ?? 0).toLocaleString()} sub="Members" />
            ))}
          </div>
        )}

        {kind === 'possible_duplicates' && (
          <div className="no-print grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Open cases" value={data.length} sub="Awaiting a decision" tone={data.length ? 'warning' : 'success'} />
            <KpiCard label="Very likely" value={data.filter((r) => r.band === 'VERY_LIKELY').length} sub="95% and above" tone="danger" />
            <KpiCard label="Possible" value={data.filter((r) => r.band === 'POSSIBLE').length} sub="80 – 94%" />
            <KpiCard label="Potential" value={data.filter((r) => r.band === 'POTENTIAL').length} sub="60 – 79%" />
          </div>
        )}

        {kind === 'data_quality' && (
          <div className="no-print grid grid-cols-2 gap-3 lg:grid-cols-4">
            {data.slice(0, 4).map((r, i) => (
              <KpiCard key={i} label={String(r.label ?? r.metric ?? `Metric ${i + 1}`)} value={Number(r.count ?? 0).toLocaleString()}
                sub={String(r.severity ?? '')} tone={r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warning' : 'neutral'} />
            ))}
          </div>
        )}
      </div>

      {error && (
        <Card className="card-pad mb-4 border-red-200">
          <p className="flex items-start gap-2 text-xs text-red-800"><IconAlert className="mt-0.5" /> {error}</p>
        </Card>
      )}

      {loading ? (
        <Card className="card-pad space-y-2"><Skeleton className="h-6 w-48" /><Skeleton className="h-40" /></Card>
      ) : data.length === 0 ? (
        <Card className="card-pad text-center">
          <IconChart className="mx-auto h-8 w-8 text-slate-400" />
          <p className="mt-2 text-sm font-semibold text-ink">Nothing to report for this period</p>
          <p className="mt-1 text-xs text-ink-soft">Widen the date range, or clear the barangay filter.</p>
        </Card>
      ) : (
        <DataTable
          rows={data}
          columns={columns}
          rowKey={(r) => String(r.id ?? r.reference_no ?? r.case_id ?? r.barangay ?? r.user ?? r.action ?? 'row')}
          limit={100}
          dense
          stickyHeader={false}
          exportName={`nmbr-${kind}`}
        />
      )}

      <Card className="card-pad mt-4 no-print">
        <h2 className="section-title">Report notes</h2>
        <ul className="mt-2 grid grid-cols-1 gap-2 text-[11px] text-ink-soft sm:grid-cols-2">
          <li>Counts exclude archived and merged records, so they match the active registry.</li>
          <li>Transfers are counted per move, so one resident can appear more than once in a year.</li>
          <li>Duplicate figures come from case records, not from re-scoring, so they stay stable across runs.</li>
          <li>Use Print / PDF for the signed copy and CSV for further analysis in Excel.</li>
        </ul>
      </Card>
    </>
  )
}

function columnsFor(kind: Kind, navigate: (path: string) => void): Array<Column<ReportRow>> {
  const openMember = (id: unknown) => (
    <Button size="sm" variant="ghost" onClick={() => navigate(`/members/${String(id)}`)}>Open</Button>
  )
  switch (kind) {
    case 'by_barangay':
      return [
        { key: 'barangay', header: 'Barangay', value: (r) => String(r.barangay ?? '') },
        { key: 'total', header: 'Total', value: (r) => Number(r.total ?? 0), align: 'right' },
        { key: 'active', header: 'Active', value: (r) => Number(r.active ?? 0), align: 'right' },
        { key: 'inactive', header: 'Inactive', value: (r) => Number(r.inactive ?? 0), align: 'right' },
        { key: 'for_review', header: 'For review', value: (r) => Number(r.for_review ?? 0), align: 'right' },
        { key: 'new_in_period', header: 'New in period', value: (r) => Number(r.new_in_period ?? 0), align: 'right' },
        { key: 'male', header: 'Male', value: (r) => Number(r.male ?? 0), align: 'right' },
        { key: 'female', header: 'Female', value: (r) => Number(r.female ?? 0), align: 'right' },
        { key: 'duplicates', header: 'Duplicates', value: (r) => Number(r.duplicates ?? 0), align: 'right',
          render: (r) => (Number(r.duplicates ?? 0) > 0 ? <Badge tone="danger">{String(r.duplicates)}</Badge> : <span className="text-ink-soft">0</span>) },
        { key: 'share', header: 'Share', value: (r) => Number(r.total ?? 0), sortable: false,
          render: (r) => <div className="w-24"><Progress value={Number(r.total ?? 0)} tone="info" /></div> },
      ]
    case 'by_sex':
      return [
        { key: 'sex', header: 'Sex', value: (r) => String(r.sex ?? '') },
        { key: 'total', header: 'Members', value: (r) => Number(r.total ?? 0), align: 'right' },
      ]
    case 'by_age_group':
      return [
        { key: 'group', header: 'Age group', value: (r) => String(r.group ?? '') },
        { key: 'total', header: 'Members', value: (r) => Number(r.total ?? 0), align: 'right' },
      ]
    case 'new_members':
      return [
        { key: 'name', header: 'Member', value: (r) => fullName(r as unknown as PersonIndexRow),
          render: (r) => (
            <div>
              <p className="text-xs font-semibold text-ink">{fullName(r as unknown as PersonIndexRow)}</p>
              <p className="mono text-[11px] text-ink-soft">{String(r.reference_no ?? '')}</p>
            </div>
          ) },
        { key: 'barangay', header: 'Barangay', value: (r) => String(r.barangay_name ?? '—') },
        { key: 'dob', header: 'Birthdate', value: (r) => String(r.date_of_birth ?? ''), render: (r) => formatDate(String(r.date_of_birth ?? '')) },
        { key: 'created', header: 'Registered', value: (r) => String(r.updated_at ?? ''), render: (r) => relativeTime(String(r.updated_at ?? '')) },
        { key: 'open', header: '', value: () => '', sortable: false, render: (r) => openMember(r.id) },
      ]
    case 'transferred':
      return [
        { key: 'name', header: 'Member', value: (r) => fullName((r.person ?? {}) as PersonIndexRow) },
        { key: 'barangay', header: 'Barangay', value: (r) => String(r.barangay ?? '') },
        { key: 'from', header: 'Effective from', value: (r) => String(r.effective_from ?? ''), render: (r) => formatDate(String(r.effective_from ?? '')) },
        { key: 'to', header: 'Effective to', value: (r) => String(r.effective_to ?? ''), render: (r) => (r.effective_to ? formatDate(String(r.effective_to)) : 'Current') },
        { key: 'reason', header: 'Reason', value: (r) => String(r.reason ?? ''), render: (r) => <Badge tone="info">{String(r.reason ?? '—').replace(/_/g, ' ').toLowerCase()}</Badge> },
        { key: 'notes', header: 'Notes', value: (r) => String(r.notes ?? '—'), defaultHidden: true },
        { key: 'recorded', header: 'Recorded', value: (r) => String(r.recorded_at ?? ''), render: (r) => relativeTime(String(r.recorded_at ?? '')) },
        { key: 'by', header: 'Recorded by', value: (r) => String(r.recorded_by ?? '—') },
      ]
    case 'possible_duplicates':
      return [
        { key: 'a', header: 'Record A', value: (r) => fullName((r.person_a ?? {}) as PersonIndexRow) },
        { key: 'b', header: 'Record B', value: (r) => fullName((r.person_b ?? {}) as PersonIndexRow) },
        { key: 'score', header: 'Match', value: (r) => Number(r.score ?? 0),
          render: (r) => <MatchBadge band={String(r.band ?? '')} score={Number(r.score ?? 0)} /> },
        { key: 'fields', header: 'Matching fields', value: (r) => String((r.fields as string[] | undefined)?.join(', ') ?? ''), defaultHidden: true },
        { key: 'created', header: 'Opened', value: (r) => String(r.created_at ?? ''), render: (r) => relativeTime(String(r.created_at ?? '')) },
      ]
    case 'resolved_duplicates':
      return [
        { key: 'a', header: 'Record A', value: (r) => fullName((r.person_a ?? {}) as PersonIndexRow) },
        { key: 'b', header: 'Record B', value: (r) => fullName((r.person_b ?? {}) as PersonIndexRow) },
        { key: 'status', header: 'Decision', value: (r) => String(r.status ?? ''), render: (r) => <StatusBadge status={String(r.status ?? '')} /> },
        { key: 'score', header: 'Match', value: (r) => Number(r.score ?? 0), render: (r) => <MatchBadge band={String(r.band ?? '')} score={Number(r.score ?? 0)} /> },
        { key: 'reason', header: 'Resolution', value: (r) => String(r.resolution ?? r.notes ?? '—') },
        { key: 'by', header: 'Reviewed by', value: (r) => String(r.reviewed_by ?? '—') },
        { key: 'at', header: 'Reviewed', value: (r) => String(r.reviewed_at ?? ''), render: (r) => (r.reviewed_at ? relativeTime(String(r.reviewed_at)) : '—') },
      ]
    case 'data_quality':
      return [
        { key: 'label', header: 'Category', value: (r) => String(r.label ?? '') },
        { key: 'count', header: 'Records', value: (r) => Number(r.count ?? 0), align: 'right' },
        { key: 'severity', header: 'Severity', value: (r) => String(r.severity ?? ''),
          render: (r) => <Badge tone={r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warning' : 'info'}>{String(r.severity ?? '')}</Badge> },
        { key: 'description', header: 'What it means', value: (r) => String(r.description ?? '') },
      ]
    case 'encoder_activity':
      return [
        { key: 'user', header: 'Staff member', value: (r) => String(r.user ?? '') },
        { key: 'created', header: 'Created', value: (r) => Number(r.created ?? 0), align: 'right' },
        { key: 'updated', header: 'Edited', value: (r) => Number(r.updated ?? 0), align: 'right' },
        { key: 'transferred', header: 'Transferred', value: (r) => Number(r.transferred ?? 0), align: 'right' },
        { key: 'merged', header: 'Merged', value: (r) => Number(r.merged ?? 0), align: 'right' },
        { key: 'duplicate_reviews', header: 'Duplicate decisions', value: (r) => Number(r.duplicate_reviews ?? 0), align: 'right' },
        { key: 'imported', header: 'Imported', value: (r) => Number(r.imported ?? 0), align: 'right' },
        { key: 'total', header: 'Total actions', value: (r) => Number(r.total ?? 0), align: 'right' },
      ]
    case 'audit_summary':
      return [
        { key: 'action', header: 'Action', value: (r) => String(r.action ?? '') },
        { key: 'total', header: 'Entries', value: (r) => Number(r.total ?? 0), align: 'right' },
      ]
    default:
      return []
  }
}

function summarise(kind: Kind, data: ReportRow[]) {
  if (kind === 'by_barangay') {
    return {
      total: data.reduce((a, r) => a + Number(r.total ?? 0), 0),
      newInPeriod: data.reduce((a, r) => a + Number(r.new_in_period ?? 0), 0),
      duplicates: data.reduce((a, r) => a + Number(r.duplicates ?? 0), 0),
    }
  }
  return { total: 0, newInPeriod: 0, duplicates: 0 }
}

function exportRows(kind: Kind, data: ReportRow[]) {
  if (data.length === 0) return
  const header = Object.keys(data[0])
  void (async () => {
    await downloadXlsx(
      header,
      data.map((row) => header.map((h) => {
        const v = row[h]
        return typeof v === 'object' && v !== null ? JSON.stringify(v) : (v as string | number | null | undefined)
      })),
      `nmbr-${kind}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      kind.replace(/_/g, ' ').slice(0, 31),
    )
  })()
}
