import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import type { Barangay } from '../lib/types'
import { relativeTime } from '../lib/utils'
import {
  Badge, Button, Card, ConfirmDialog, Field, IconCheck, IconCopy, IconEdit, IconMap, IconPlus, IconRefresh,
  IconUsers, KpiCard, Modal, useToast,
} from '../components/ui'

export default function Barangays() {
  const { api, user, settings } = useApp()
  const navigate = useNavigate()
  const toast = useToast()
  const [rows, setRows] = useState<Barangay[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<Barangay | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', district: '', active: true })
  const [busy, setBusy] = useState(false)
  const [deactivate, setDeactivate] = useState<Barangay | null>(null)

  const canManage = user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)

  const load = async () => {
    setLoading(true)
    try {
      setRows(await api.listBarangays(true))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  const filtered = rows
    .filter((b) => (showInactive ? true : b.active))
    .filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))

  const totals = rows.reduce(
    (acc, b) => ({
      members: acc.members + (b.total_members ?? 0),
      duplicates: acc.duplicates + (b.possible_duplicates ?? 0),
      today: acc.today + (b.new_today ?? 0),
    }),
    { members: 0, duplicates: 0, today: 0 },
  )

  const openForm = (b?: Barangay) => {
    setForm({ name: b?.name ?? '', district: b?.district ?? '', active: b?.active ?? true })
    if (b) setEditing(b)
    else setCreating(true)
  }

  const save = async () => {
    if (!form.name.trim()) return
    setBusy(true)
    const res = await api.upsertBarangay({
      id: editing?.id, name: form.name.trim(), district: form.district || null, active: form.active,
      municipality: editing?.municipality ?? settings.municipality,
      province: editing?.province ?? settings.province,
    } as Partial<Barangay> & { name: string })
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Could not save the barangay', message: res.error })
      return
    }
    toast.push({ tone: 'success', title: editing ? 'Barangay updated' : 'Barangay added' })
    setEditing(null)
    setCreating(false)
    await load()
  }

  const toggleActive = async (reason: string) => {
    if (!deactivate) return
    setBusy(true)
    const res = await api.upsertBarangay({
      id: deactivate.id, name: deactivate.name, active: !deactivate.active,
      municipality: deactivate.municipality, province: deactivate.province,
    } as Partial<Barangay> & { name: string })
    if (res.ok) {
      await api.logEvent('BARANGAY_STATUS_CHANGED', 'BARANGAY', deactivate.id, deactivate.name,
        { active: !deactivate.active }, reason || null)
      toast.push({ tone: 'success', title: `Barangay marked ${deactivate.active ? 'inactive' : 'active'}` })
      await load()
    } else {
      toast.push({ tone: 'error', title: 'Could not update the barangay', message: res.error })
    }
    setBusy(false)
    setDeactivate(null)
  }

  const columns: Array<Column<Barangay>> = [
    {
      key: 'name', header: 'Barangay', value: (b) => b.name,
      render: (b) => (
        <div>
          <p className="font-semibold text-ink">{b.name}</p>
          <p className="text-[11px] text-ink-soft">{[b.district, b.municipality].filter(Boolean).join(' · ')}</p>
        </div>
      ),
    },
    { key: 'total_members', header: 'Registered members', value: (b) => b.total_members ?? 0, align: 'right',
      render: (b) => <span className="text-sm font-semibold">{(b.total_members ?? 0).toLocaleString()}</span> },
    { key: 'active_members', header: 'Active', value: (b) => b.active_members ?? 0, align: 'right' },
    { key: 'new_today', header: 'New today', value: (b) => b.new_today ?? 0, align: 'right',
      render: (b) => (b.new_today ? <Badge tone="info">+{b.new_today}</Badge> : <span className="text-ink-soft">0</span>) },
    { key: 'possible_duplicates', header: 'Possible duplicates', value: (b) => b.possible_duplicates ?? 0, align: 'right',
      render: (b) => (b.possible_duplicates ? <Badge tone="danger">{b.possible_duplicates}</Badge> : <span className="text-ink-soft">0</span>) },
    { key: 'for_review', header: 'For review', value: (b) => b.for_review ?? 0, align: 'right' },
    { key: 'last_updated', header: 'Last update', value: (b) => b.last_updated ?? '',
      render: (b) => <span className="text-xs text-ink-soft">{b.last_updated ? relativeTime(b.last_updated) : '—'}</span> },
    { key: 'status', header: 'Status', value: (b) => (b.active ? 'Active' : 'Inactive'),
      render: (b) => <Badge tone={b.active ? 'success' : 'muted'}>{b.active ? 'Active' : 'Inactive'}</Badge> },
    {
      key: 'actions', header: 'Actions', value: () => '', sortable: false,
      render: (b) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/barangays/${b.id}`)}>
            <IconUsers /> Open registry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/members/new?barangay=${b.id}`)}>
            <IconPlus /> Add member
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/duplicates?barangay=${b.id}`)}>
            <IconCopy /> Duplicates
          </Button>
          {canManage && (
            <>
              <Button size="sm" variant="ghost" onClick={() => openForm(b)} title="Rename or reclassify">
                <IconEdit />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={b.active ? 'text-red-700' : 'text-emerald-700'}
                onClick={() => setDeactivate(b)}
              >
                {b.active ? 'Deactivate' : 'Reactivate'}
              </Button>
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title="Barangay Directory"
        subtitle="All barangays of the municipality with live member counts. Records are centralised — a barangay is a location, not a separate database."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <IconRefresh /> Refresh
            </Button>
            {canManage && (
              <Button variant="primary" size="sm" onClick={() => openForm()}>
                <IconPlus /> Add barangay
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Barangays" value={rows.filter((b) => b.active).length} sub={`${rows.length} total on file`} icon={<IconMap />} />
        <KpiCard label="Registered members" value={totals.members.toLocaleString()} sub="Across all barangays" icon={<IconUsers />} />
        <KpiCard label="New today" value={totals.today} sub="Encoded since midnight" icon={<IconPlus />} tone={totals.today ? 'success' : 'neutral'} />
        <KpiCard label="Possible duplicates" value={totals.duplicates} sub="Pairs awaiting a decision" icon={<IconCopy />}
          tone={totals.duplicates ? 'danger' : 'success'} onClick={() => navigate('/duplicates')} />
      </div>

      <div className="mt-4">
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(b) => b.id}
          loading={loading}
          onRowClick={(b) => navigate(`/barangays/${b.id}`)}
          search={query}
          onSearch={setQuery}
          searchPlaceholder="Search barangay name…"
          exportName="barangay-directory"
          total={filtered.length}
          limit={50}
          mobilePrimary={['name', 'total_members']}
          filters={
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
          }
          emptyTitle="No barangays found"
          emptyMessage="Adjust the search term, or add a barangay to the municipality."
        />
      </div>

      <Card className="card-pad mt-4">
        <h2 className="section-title">One person = one master record</h2>
        <p className="mt-1.5 text-xs text-ink-soft">
          A resident who moves from one barangay to another keeps the <span className="font-semibold text-ink">same</span> master
          record. The registry records the move in the barangay history instead of creating a second person, which is why
          per-barangay totals always sum to the municipal total.
        </p>
      </Card>

      {/* add / edit barangay */}
      <Modal
        open={creating || !!editing}
        onClose={() => { setCreating(false); setEditing(null) }}
        title={editing ? `Edit ${editing.name}` : 'Add barangay'}
        description="Barangays cannot be deleted — deactivate them instead so their history stays intact."
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCreating(false); setEditing(null) }}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={() => void save()}>
              <IconCheck /> Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Barangay name" required>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="San Isidro" />
          </Field>
          <Field label="District / cluster" hint="Optional grouping used in reports.">
            <input className="input" value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} placeholder="Poblacion Cluster" />
          </Field>
          <label className="flex items-center gap-2 text-xs font-medium">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active (accepts new member records)
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deactivate}
        title={deactivate?.active ? `Deactivate ${deactivate?.name}?` : `Reactivate ${deactivate?.name}?`}
        message={
          deactivate?.active
            ? 'Existing members stay in the registry and remain searchable. New records cannot be assigned to this barangay until it is reactivated. Nothing is deleted.'
            : 'The barangay becomes available again for new member records.'
        }
        confirmLabel={deactivate?.active ? 'Deactivate' : 'Reactivate'}
        tone={deactivate?.active ? 'warning' : 'primary'}
        requireReason={!!deactivate?.active}
        onClose={() => setDeactivate(null)}
        onConfirm={(reason) => void toggleActive(reason)}
      />
    </>
  )
}
