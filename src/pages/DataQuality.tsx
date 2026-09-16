import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import type { Barangay, DataQualityRow, Person } from '../lib/types'
import { cn, formatDate, downloadXlsx, downloadPdf } from '../lib/utils'
import { fullName } from '../lib/normalize'
import {
  Badge, Button, Card, IconAlert, IconDownload, IconEye, IconPlus, IconRefresh, IconSearch,
  IconShieldCheck, IconUpload, Modal, Skeleton, StatusBadge, useToast,
} from '../components/ui'

const SEVERITY_TONE: Record<string, string> = { high: 'danger', medium: 'warning', low: 'info' }

/** Data-quality metrics that can be drilled into from the offline analytics engine. */
const DRILLABLE = new Set(['missing_birthdate', 'missing_sex', 'invalid_contact', 'incomplete_address', 'duplicate_contact', 'same_name_different_dob', 'for_review'])

export default function DataQuality() {
  const { api, user, online } = useApp()
  const navigate = useNavigate()
  const toast = useToast()

  const [rows, setRows] = useState<DataQualityRow[]>([])
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<DataQualityRow | null>(null)
  const [records, setRecords] = useState<Person[]>([])
  const [groups, setGroups] = useState<Array<{ key: string; members: Person[] }>>([])
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [q, b] = await Promise.all([api.dataQuality(), api.listBarangays(true)])
      setRows(q)
      setBarangays(b)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load, online])

  const totalIssues = rows.reduce((acc, r) => acc + r.count, 0)

  const openDetail = async (row: DataQualityRow) => {
    setDetail(row)
    setRecords([])
    setGroups([])
    setQuery('')
    setBusy(true)
    try {
      if (row.id === 'duplicate_contact' || row.id === 'same_name_different_dob') {
        const raw = await api.qualityRecords(row.id, 100) as Array<Record<string, unknown>>
        setGroups(raw.map((g) => ({
          key: String(g.contact ?? g.name ?? '—'),
          members: (g.members as Person[]) ?? [],
        })))
      } else {
        const res = await api.searchPersons({ attention: row.id, limit: 100 })
        setRecords(res.rows)
      }
    } finally {
      setBusy(false)
    }
  }

  const exportDetail = (fmt: 'xlsx' | 'pdf' = 'xlsx') => {
    if (!detail) return
    void (async () => {
      if (groups.length) {
        await (fmt === 'xlsx' ? downloadXlsx(
          ['Group', 'Reference No.', 'Name', 'Birthdate', 'Barangay', 'Contact'],
          groups.flatMap((g) => g.members.map((p) => [
            g.key, p.reference_no, fullName(p),
            p.date_of_birth ?? '', p.barangay_name ?? '', p.contact_number ?? '',
          ])),
          `nmbr-data-quality-${detail.id}.xlsx`, 'Data quality',
        ) : downloadPdf({
          title: `Data quality — ${detail.id.replace(/_/g, ' ')}`,
          subtitle: 'Municipality of Nabua, Province of Camarines Sur',
          headers: ['Group', 'Reference No.', 'Name', 'Birthdate', 'Barangay', 'Contact'],
          rows: groups.flatMap((g) => g.members.map((p) => [
            g.key, p.reference_no, fullName(p),
            p.date_of_birth ?? '', p.barangay_name ?? '', p.contact_number ?? '',
          ])),
          filename: `nmbr-data-quality-${detail.id}.pdf`,
          meta: [`Generated: ${new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}`,
            `Records in this extract: ${groups.reduce((a, g) => a + g.members.length, 0)}`],
        }))
        toast.push({ tone: 'info', title: 'Export created', message: fmt === 'pdf' ? 'The list was written to a PDF file.' : 'The list was written to an Excel file.' })
        return
      }
      await (fmt === 'xlsx' ? downloadXlsx(
        ['Reference No.', 'Name', 'Birthdate', 'Sex', 'Barangay', 'Purok', 'Address', 'Contact', 'Status'],
        records.map((p) => [
          p.reference_no, fullName(p), p.date_of_birth ?? '',
          p.sex ?? '', p.barangay_name ?? '', p.purok ?? '', p.address ?? '',
          p.contact_number ?? '', p.status,
        ]),
        `nmbr-data-quality-${detail.id}.xlsx`, 'Data quality',
      ) : downloadPdf({
        title: `Data quality — ${detail.id.replace(/_/g, ' ')}`,
        subtitle: 'Municipality of Nabua, Province of Camarines Sur',
        headers: ['Reference No.', 'Name', 'Birthdate', 'Sex', 'Barangay', 'Purok', 'Address', 'Contact', 'Status'],
        rows: records.map((p) => [
          p.reference_no, fullName(p), p.date_of_birth ?? '',
          p.sex ?? '', p.barangay_name ?? '', p.purok ?? '', p.address ?? '',
          p.contact_number ?? '', p.status,
        ]),
        filename: `nmbr-data-quality-${detail.id}.pdf`,
        meta: [`Generated: ${new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}`,
          `Records in this extract: ${records.length}`],
      }))
      toast.push({ tone: 'info', title: 'Export created', message: fmt === 'pdf' ? 'The list was written to a PDF file.' : 'The list was written to an Excel file.' })
    })()
  }

  const columns: Array<Column<Person>> = [
    { key: 'name', header: 'Member', value: (p) => fullName(p),
      render: (p) => (
        <div>
          <p className="text-sm font-semibold text-ink">{fullName(p)}</p>
          <p className="mono text-[11px] text-ink-soft">{p.reference_no}</p>
        </div>
      ) },
    { key: 'barangay', header: 'Barangay', value: (p) => p.barangay_name ?? '—' },
    { key: 'dob', header: 'Birthdate', value: (p) => p.date_of_birth ?? '', render: (p) => formatDate(p.date_of_birth) },
    { key: 'sex', header: 'Sex', value: (p) => p.sex ?? '—' },
    { key: 'purok', header: 'Purok', value: (p) => p.purok ?? '—' },
    { key: 'contact', header: 'Contact', value: (p) => p.contact_number ?? '—' },
    { key: 'status', header: 'Status', value: (p) => p.status, render: (p) => <StatusBadge status={p.status} /> },
    { key: 'open', header: '', value: () => '', sortable: false,
      render: (p) => <Button size="sm" variant="secondary" onClick={() => navigate(`/members/${p.id}`)}>Fix</Button> },
  ]

  return (
    <>
      <PageHeader
        title="Data Quality Center"
        subtitle="Incomplete data is the main cause of missed duplicates. Work through these categories to raise the quality of the municipal registry."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}><IconRefresh /> Re-scan</Button>
            {user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role) && (
              <Button variant="primary" size="sm" onClick={() => navigate('/imports')}><IconUpload /> Bulk clean-up via import</Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="card-pad">
          <p className="text-[11px] font-semibold tracking-wide text-ink-soft uppercase">Total issues flagged</p>
          <p className="mt-1 text-2xl font-bold text-ink">{loading ? <Skeleton className="h-7 w-16" /> : totalIssues.toLocaleString()}</p>
          <p className="mt-1 text-[11px] text-ink-soft">Across {rows.length} quality categories</p>
        </Card>
        <Card className="card-pad">
          <p className="text-[11px] font-semibold tracking-wide text-ink-soft uppercase">High severity</p>
          <p className="mt-1 text-2xl font-bold text-red-700">
            {loading ? <Skeleton className="h-7 w-16" /> : rows.filter((r) => r.severity === 'high').reduce((a, r) => a + r.count, 0)}
          </p>
          <p className="mt-1 text-[11px] text-ink-soft">Duplicates, missing barangay, records flagged for review</p>
        </Card>
        <Card className="card-pad">
          <p className="text-[11px] font-semibold tracking-wide text-ink-soft uppercase">Records in the registry</p>
          <p className="mt-1 text-2xl font-bold text-ink">
            {loading ? <Skeleton className="h-7 w-16" /> : barangays.reduce((a, b) => a + (b.total_members ?? 0), 0).toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-ink-soft">Master records counted across {barangays.length} barangays</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {loading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        {!loading && rows.map((row) => (
          <Card key={row.id} className={cn('card-pad', row.count > 0 && 'border-l-4', row.count > 0 && `border-l-${SEVERITY_TONE[row.severity] === 'danger' ? 'red' : SEVERITY_TONE[row.severity] === 'warning' ? 'amber' : 'gov'}-400`)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-ink">{row.label}</h2>
                <p className="mt-0.5 text-[11px] text-ink-soft">{row.description}</p>
              </div>
              <Badge tone={SEVERITY_TONE[row.severity]}>{row.severity}</Badge>
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <p className={cn('text-2xl font-bold', row.count === 0 ? 'text-emerald-700' : row.severity === 'high' ? 'text-red-700' : 'text-ink')}>
                {row.count.toLocaleString()}
              </p>
              <div className="flex gap-1.5">
                {DRILLABLE.has(row.id) && row.count > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => void openDetail(row)}><IconEye /> Review</Button>
                )}
                {row.id === 'possible_duplicates' && row.count > 0 && (
                  <Button size="sm" variant="primary" onClick={() => navigate('/duplicates')}>Open cases</Button>
                )}
              </div>
            </div>
            {row.count === 0 && <p className="mt-2 text-[11px] font-medium text-emerald-700">Nothing to correct here.</p>}
          </Card>
        ))}
      </div>

      <Card className="card-pad mt-4">
        <h2 className="section-title"><IconShieldCheck /> How to use this centre</h2>
        <ul className="mt-2 grid grid-cols-1 gap-2 text-xs text-ink-soft sm:grid-cols-2">
          <li><span className="font-semibold text-ink">Missing birthdate</span> — the single strongest matching field. Add it from the member profile.</li>
          <li><span className="font-semibold text-ink">Missing sex</span> — cheap to fix during verification drives.</li>
          <li><span className="font-semibold text-ink">Shared contact numbers</span> — often a family number; check for a person encoded twice.</li>
          <li><span className="font-semibold text-ink">Same name, different birthdate</span> — a common sign of a duplicate with a typo in the birthdate.</li>
          <li><span className="font-semibold text-ink">For review</span> — records created despite a likely duplicate; a supervisor must decide.</li>
          <li><span className="font-semibold text-ink">Archived</span> — merged or retired records kept for the audit trail, never counted as active members.</li>
        </ul>
      </Card>

      {/* ------------------------------------------------ drill-down */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.label ?? 'Data quality'}
        description={detail?.description}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDetail(null)}>Close</Button>
            <Button variant="secondary" onClick={() => exportDetail()}><IconDownload /> Export Excel</Button>
            <Button variant="secondary" onClick={() => exportDetail('pdf')}><IconDownload /> PDF</Button>
            {detail?.id === 'possible_duplicates' && (
              <Button variant="primary" onClick={() => navigate('/duplicates')}>Open Duplicate Center</Button>
            )}
          </>
        }
      >
        {busy && <Skeleton className="h-40" />}

        {!busy && groups.length > 0 && (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.key} className="rounded-md border border-line">
                <div className="flex items-center justify-between gap-2 border-b border-line bg-slate-50 px-3 py-2">
                  <p className="text-xs font-semibold text-ink">
                    {detail?.id === 'duplicate_contact' ? `Contact ${g.key}` : g.key}
                  </p>
                  <Badge tone="warning">{g.members.length} records</Badge>
                </div>
                <ul className="divide-y divide-line">
                  {g.members.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-ink">{fullName(p)}</span>
                        <span className="text-[11px] text-ink-soft">
                          {p.barangay_name ?? '—'} · born {formatDate(p.date_of_birth)} · <span className="mono">{p.reference_no}</span>
                        </span>
                      </span>
                      <Button size="sm" variant="secondary" onClick={() => navigate(`/members/${p.id}`)}>Open</Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {!busy && groups.length === 0 && detail?.id === 'for_review' && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <IconAlert className="mt-0.5" />
            <span>
              These records were accepted despite a close match. Verify each one against the person’s documents before
              changing its status.
            </span>
          </div>
        )}

        {!busy && groups.length === 0 && records.length > 0 && (
          <>
            <div className="relative mb-3">
              <IconSearch className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-slate-400" />
              <input
                className="input pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, barangay or reference number"
              />
            </div>
            <DataTable
              rows={records.filter((p) => {
                const q = query.trim().toLowerCase()
                if (!q) return true
                return [fullName(p), p.reference_no, p.barangay_name ?? '', p.purok ?? ''].join(' ').toLowerCase().includes(q)
              })}
              columns={columns}
              rowKey={(p) => p.id}
              limit={100}
              dense
              stickyHeader={false}
            />
          </>
        )}

        {!busy && groups.length === 0 && records.length === 0 && (
          <p className="py-8 text-center text-xs text-ink-soft">Nothing to correct in this category.</p>
        )}
      </Modal>
    </>
  )
}
