import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import type { AuditLogRow, ManagedUser } from '../lib/types'
import { formatDateTime, relativeTime, downloadXlsx, downloadPdf } from '../lib/utils'
import { Badge, Button, Card, Field, IconAlert, IconDownload, IconEye, IconRefresh, IconScroll, Modal, useToast } from '../components/ui'

const ACTIONS = [
  'SIGNIN', 'LOGOUT', 'CREATED', 'UPDATED', 'TRANSFERRED', 'STATUS_CHANGED', 'ARCHIVED', 'MERGED',
  'DUPLICATE_REVIEWED', 'DUPLICATE_OPENED', 'IMPORTED', 'IMPORT_STAGED', 'USER_UPDATED',
  'BARANGAY_UPDATED', 'SETTINGS_UPDATED', 'EXPORT_MEMBER_LIST', 'VIEWED',
]

const ENTITIES = ['PERSONS', 'PERSON', 'DUPLICATE_CASES', 'IMPORT_BATCHES', 'USERS', 'BARANGAYS', 'SYSTEM_SETTINGS']

export default function AuditLogs() {
  const toast = useToast()
  const { api, user } = useApp()
  const [rows, setRows] = useState<AuditLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [action, setAction] = useState('')
  const [entity, setEntity] = useState('')
  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [limit, setLimit] = useState(50)
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<AuditLogRow | null>(null)

  useEffect(() => {
    const handle = setTimeout(() => { setDebounced(query.trim()); setOffset(0) }, 300)
    return () => clearTimeout(handle)
  }, [query])

  useEffect(() => {
    void api.listUsers().then(setUsers).catch(() => undefined)
  }, [api])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.listAudit({
        query: debounced || undefined, action: action || null, entity: entity || null,
        user_id: userId || null, from: from || null, to: to || null, limit, offset,
      })
      setRows(res.rows)
      setTotal(res.total)
    } finally {
      setLoading(false)
    }
  }, [api, debounced, action, entity, userId, from, to, limit, offset])

  useEffect(() => {
    void load()
  }, [load])

  const exportPdf = () => {
    void (async () => {
      try {
        await downloadPdf({
          title: 'Audit Log',
          subtitle: 'Municipal Barangay Registry — Municipality of Nabua, Province of Camarines Sur',
          headers: ['Timestamp', 'User', 'Action', 'Entity', 'Record', 'Reason', 'Previous values', 'New values'],
          rows: rows.map((r) => [
            r.timestamp, r.user_name ?? 'System', r.action, r.entity_type, r.entity_label ?? r.entity_id ?? '',
            r.reason ?? '', JSON.stringify(r.old_values ?? ''), JSON.stringify(r.new_values ?? ''),
          ]),
          filename: `nmbr-audit-log-${new Date().toISOString().slice(0, 10)}.pdf`,
          meta: [`Generated: ${new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}`,
            `Entries in this extract: ${rows.length}`],
        })
      } catch (err) {
        toast.push({ tone: 'error', title: 'Export failed', message: err instanceof Error ? err.message : String(err) })
      }
    })()
  }

  const exportCsv = () => {
    void (async () => {
      await downloadXlsx(
        ['Timestamp', 'User', 'Action', 'Entity', 'Record', 'Reason', 'Previous values', 'New values'],
        rows.map((r) => [
          r.timestamp, r.user_name ?? 'System', r.action, r.entity_type, r.entity_label ?? r.entity_id ?? '',
          r.reason ?? '', JSON.stringify(r.old_values ?? ''), JSON.stringify(r.new_values ?? ''),
        ]),
        `nmbr-audit-log-${new Date().toISOString().slice(0, 10)}.xlsx`, 'Audit log',
      )
    })()
  }


  const columns: Array<Column<AuditLogRow>> = [
    {
      key: 'timestamp', header: 'When', value: (r) => r.timestamp,
      render: (r) => (
        <div>
          <p className="text-xs font-medium text-ink">{formatDateTime(r.timestamp)}</p>
          <p className="text-[11px] text-ink-soft">{relativeTime(r.timestamp)}</p>
        </div>
      ),
    },
    { key: 'user', header: 'User', value: (r) => r.user_name ?? 'System',
      render: (r) => <span className="text-xs">{r.user_name ?? 'System'}</span> },
    { key: 'action', header: 'Action', value: (r) => r.action,
      render: (r) => <Badge tone={tone(r.action)}>{r.action.replace(/_/g, ' ')}</Badge> },
    { key: 'entity', header: 'Entity', value: (r) => r.entity_type,
      render: (r) => <span className="text-[11px] text-ink-soft">{r.entity_type}</span> },
    { key: 'label', header: 'Record', value: (r) => r.entity_label ?? r.entity_id ?? '—',
      render: (r) => <span className="mono text-[11px]">{r.entity_label ?? r.entity_id ?? '—'}</span> },
    { key: 'reason', header: 'Reason', value: (r) => r.reason ?? '—', defaultHidden: true },
    {
      key: 'changes', header: 'Changes', value: () => '', sortable: false,
      render: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setDetail(r)}>
          <IconEye /> View
        </Button>
      ),
    },
    { key: 'session', header: 'Device', value: (r) => String((r.session_info as { device?: string } | null)?.device ?? '—'),
      defaultHidden: true,
      render: (r) => <span className="text-[11px] text-ink-soft">{String((r.session_info as { device?: string } | null)?.device ?? '—')}</span> },
  ]

  if (!user) return null

  return (
    <>
      <PageHeader
        title="Audit Logs"
        subtitle="Every add, edit, transfer, merge, import, sign-in and export is recorded with the user, time, reason and the previous and new values."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}><IconRefresh /> Refresh</Button>
            <Button variant="secondary" size="sm" onClick={exportCsv}><IconDownload /> Export Excel</Button>
            <Button variant="secondary" size="sm" onClick={exportPdf}><IconDownload /> PDF</Button>
          </>
        }
      />

      {user.role === 'ENCODER' && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-gov-200 bg-gov-50 px-3 py-2 text-xs text-gov-900">
          <IconAlert className="mt-0.5" />
          <span>Encoders can review their own entries. Merges and user administration are restricted to Administrators.</span>
        </div>
      )}

      <Card className="card-pad mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Search" className="lg:col-span-2">
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Record name, reference or reason" />
          </Field>
          <Field label="Action">
            <select className="input" value={action} onChange={(e) => { setAction(e.target.value); setOffset(0) }}>
              <option value="">All actions</option>
              {ACTIONS.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ').toLowerCase()}</option>)}
            </select>
          </Field>
          <Field label="Entity">
            <select className="input" value={entity} onChange={(e) => { setEntity(e.target.value); setOffset(0) }}>
              <option value="">All entities</option>
              {ENTITIES.map((e2) => <option key={e2} value={e2}>{e2.replace(/_/g, ' ').toLowerCase()}</option>)}
            </select>
          </Field>
          <Field label="User">
            <select className="input" value={userId} onChange={(e) => { setUserId(e.target.value); setOffset(0) }}>
              <option value="">All users</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field label="From">
            <input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0) }} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0) }} />
          </Field>
          <Field label="Rows">
            <select className="input" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0) }}>
              {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        total={total}
        limit={limit}
        offset={offset}
        onPage={setOffset}
        dense
        exportName="audit-log"
        mobilePrimary={['action', 'user']}
        emptyTitle="No audit entries match these filters"
        emptyMessage="Widen the date range or clear the action filter."
      />

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title="Audit entry"
        description={detail ? `${detail.action.replace(/_/g, ' ')} · ${formatDateTime(detail.timestamp)}` : undefined}
        size="lg"
        footer={<Button variant="secondary" onClick={() => setDetail(null)}>Close</Button>}
      >
        {detail && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Row label="User" value={detail.user_name ?? 'System'} />
              <Row label="Role at the time" value={String((detail.session_info as { role?: string } | null)?.role ?? '—')} />
              <Row label="Entity" value={detail.entity_type} />
              <Row label="Record" value={detail.entity_label ?? detail.entity_id ?? '—'} />
              <Row label="Reason given" value={detail.reason ?? '—'} />
              <Row label="Device" value={String((detail.session_info as { device?: string } | null)?.device ?? '—')} />
            </dl>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[11px] font-semibold text-ink-soft uppercase">Previous values</p>
                <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-line bg-slate-50 p-3 text-[11px] whitespace-pre-wrap">
                  {detail.old_values ? JSON.stringify(detail.old_values, null, 2) : 'No previous value recorded.'}
                </pre>
              </div>
              <div>
                <p className="text-[11px] font-semibold text-ink-soft uppercase">New values</p>
                <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-line bg-slate-50 p-3 text-[11px] whitespace-pre-wrap">
                  {detail.new_values ? JSON.stringify(detail.new_values, null, 2) : 'No new value recorded.'}
                </pre>
              </div>
            </div>

            <p className="flex items-start gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
              <IconScroll className="mt-0.5" />
              Audit entries are append-only. They cannot be edited or deleted from the application, which keeps the
              municipal record defensible during inspections.
            </p>
          </div>
        )}
      </Modal>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold tracking-wide text-ink-soft uppercase">{label}</dt>
      <dd className="mt-0.5 text-xs text-ink">{value}</dd>
    </div>
  )
}

function tone(action: string): string {
  if (action === 'SIGNIN' || action === 'LOGOUT') return 'muted'
  if (action === 'CREATED' || action === 'IMPORTED') return 'success'
  if (action === 'MERGED') return 'info'
  if (action.includes('DUPLICATE') || action === 'STATUS_CHANGED' || action === 'ARCHIVED') return 'warning'
  if (action === 'EXPORT_MEMBER_LIST') return 'info'
  return 'neutral'
}
