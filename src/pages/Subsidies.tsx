import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import type { SubsidyBeneficiary, SubsidyProgram, Person, Barangay } from '../lib/types'
import { CLASSIFICATION_CODES } from '../lib/types'
import {
  Badge, Button, Card, ConfirmDialog, Field, IconEdit, IconGift, IconPlus, IconSearch, Modal, useToast,
} from '../components/ui'

/**
 * Subsidy (ayuda) programmes: municipal aid drives such as bigasan or the
 * walang-gutom programme. Beneficiaries are encoded per programme from the
 * paper lists each barangay submits — the encoder cross-checks the paper
 * row against the registry row before adding it.
 *
 * Eligibility is always an explicit human decision per row. The system
 * deliberately contains no rule that includes or excludes a resident from
 * aid automatically, and no political or voting classification exists anywhere
 * in it (docs/GO_LIVE.md §10).
 */
export default function Subsidies() {
  const { api, user } = useApp()
  const toast = useToast()
  const [programs, setPrograms] = useState<SubsidyProgram[]>([])
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [open, setOpen] = useState<SubsidyProgram | null>(null)
  const [editing, setEditing] = useState<SubsidyProgram | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', period_start: '', period_end: '', active: true })
  const [busy, setBusy] = useState(false)

  const [beneficiaries, setBeneficiaries] = useState<SubsidyBeneficiary[]>([])
  const [barangayFilter, setBarangayFilter] = useState('')
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<Person[]>([])
  const [adding, setAdding] = useState<Person | null>(null)
  const [addForm, setAddForm] = useState({ verified: true, paper_ref: '', notes: '', classification_code: '' })
  const [removing, setRemoving] = useState<SubsidyBeneficiary | null>(null)
  const [removeReason, setRemoveReason] = useState('')

  const canManage = user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)
  const canEncode = user && ['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)

  const loadPrograms = useCallback(async () => {
    setPrograms(await api.listSubsidyPrograms())
  }, [api])

  const loadBeneficiaries = useCallback(async () => {
    if (!open) return
    setBeneficiaries(await api.listSubsidyBeneficiaries(open.id, barangayFilter || null))
  }, [api, open, barangayFilter])

  useEffect(() => { void loadPrograms(); void api.listBarangays().then(setBarangays) }, [loadPrograms, api])
  useEffect(() => { void loadBeneficiaries() }, [loadBeneficiaries])

  useEffect(() => {
    const handle = setTimeout(() => {
      if (!open || query.trim().length < 2) { setCandidates([]); return }
      void api.searchPersons({ query: query.trim(), barangay_id: barangayFilter || null, limit: 8 })
        .then((r) => setCandidates(r.rows))
    }, 300)
    return () => clearTimeout(handle)
  }, [query, barangayFilter, api, open])

  const listedIds = useMemo(() => new Set(beneficiaries.map((b) => b.person_id)), [beneficiaries])

  const openForm = (p?: SubsidyProgram) => {
    setForm({
      name: p?.name ?? '', description: p?.description ?? '',
      period_start: p?.period_start ?? '', period_end: p?.period_end ?? '', active: p?.active ?? true,
    })
    if (p) setEditing(p); else setCreating(true)
  }

  const saveProgram = async () => {
    if (!form.name.trim()) {
      toast.push({ tone: 'error', title: 'Name required', message: 'Give the programme a name (e.g. Bigasan 2026).' })
      return
    }
    setBusy(true)
    const res = await api.upsertSubsidyProgram({
      id: editing?.id, name: form.name.trim(), description: form.description || null,
      period_start: form.period_start || null, period_end: form.period_end || null, active: form.active,
    })
    setBusy(false)
    if (!res.ok) { toast.push({ tone: 'error', title: 'Refused', message: res.error }); return }
    setEditing(null); setCreating(false)
    void loadPrograms()
    toast.push({ tone: 'success', title: 'Programme saved' })
  }

  const startAdd = (person: Person) => {
    setAdding(person)
    setAddForm({ verified: true, paper_ref: '', notes: '', classification_code: person.classification_code ?? '' })
  }

  const confirmAdd = async () => {
    if (!adding || !open) return
    setBusy(true)
    const res = await api.addSubsidyBeneficiary({
      program_id: open.id, person_id: adding.id, barangay_id: (adding.barangay_id ?? barangayFilter) || null,
      classification_code: addForm.classification_code || null,
      verified: addForm.verified, paper_ref: addForm.paper_ref || null, notes: addForm.notes || null,
    })
    setBusy(false)
    if (!res.ok) { toast.push({ tone: 'error', title: 'Not added', message: res.error }); return }
    setAdding(null); setQuery(''); setCandidates([])
    void loadBeneficiaries(); void loadPrograms()
    toast.push({ tone: 'success', title: 'Added to the programme list', message: 'Cross-check the paper row before marking verified.' })
  }

  const confirmRemove = async (reason: string) => {
    if (!removing) return
    setBusy(true)
    const res = await api.removeSubsidyBeneficiary(removing.id, reason)
    setBusy(false)
    setRemoving(null)
    if (!res.ok) { toast.push({ tone: 'error', title: 'Refused', message: res.error }); return }
    void loadBeneficiaries(); void loadPrograms()
  }

  const columns: Array<Column<SubsidyBeneficiary>> = [
    { key: 'member', header: 'Member', value: (b) => b.person_name ?? '' },
    { key: 'ref', header: 'Reference', value: (b) => b.reference_no ?? '' },
    { key: 'barangay', header: 'Barangay', value: (b) => b.person_barangay ?? '' },
    { key: 'code', header: 'Code', value: (b) => b.classification_code ?? '' },
    { key: 'verified', header: 'Verified', value: (b) => (b.verified ? 'yes' : 'pending'),
      render: (b) => (b.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Pending</Badge>) },
    { key: 'paper', header: 'Paper list ref', value: (b) => b.paper_ref ?? '' },
    { key: 'added', header: 'Added by', value: (b) => b.added_by_name ?? '' },
  ]

  return (
    <>
      <PageHeader
        title="Subsidy Programmes (Ayuda)"
        subtitle="Municipal aid drives and their beneficiary lists. Encode from the paper list each barangay submits, cross-checking every row against the registry."
        actions={canManage ? (
          <Button variant="primary" size="sm" onClick={() => openForm()}><IconPlus /> New programme</Button>
        ) : undefined}
      />

      {!open ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {programs.map((p) => (
            <Card key={p.id} className="card-pad flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <IconGift className="text-gov-700" />
                  <h2 className="text-sm font-bold text-ink">{p.name}</h2>
                </div>
                {p.active ? <Badge tone="success">Active</Badge> : <Badge>Closed</Badge>}
              </div>
              {p.description && <p className="text-xs text-ink-soft">{p.description}</p>}
              <p className="text-xs text-ink-soft">
                {p.period_start ?? '—'} → {p.period_end ?? '—'}
              </p>
              <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                <span className="text-xs text-ink-soft">
                  <strong className="text-ink">{p.beneficiaries ?? 0}</strong> listed · <strong className="text-ink">{p.verified ?? 0}</strong> verified
                </span>
                <div className="flex gap-1">
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => openForm(p)} aria-label={`Edit ${p.name}`}><IconEdit /></Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => { setOpen(p); setBarangayFilter('') }}>Open</Button>
                </div>
              </div>
            </Card>
          ))}
          {programs.length === 0 && (
            <Card className="card-pad col-span-full text-sm text-ink-soft">
              No subsidy programmes yet. {canManage ? 'Create the first one (for example “Bigasan 2026”).' : 'Ask an administrator to create one.'}
            </Card>
          )}
        </div>
      ) : (
        <>
          <Card className="card-pad mb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>← All programmes</Button>
                <span className="ml-2 text-sm font-bold text-ink">{open.name}</span>
              </div>
              <select className="input max-w-[12rem]" value={barangayFilter}
                onChange={(e) => setBarangayFilter(e.target.value)} aria-label="Filter by barangay">
                <option value="">All barangays</option>
                {barangays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            {canEncode && (
              <div className="mt-3">
                <div className="relative">
                  <IconSearch className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-slate-400" />
                  <input className="input pl-8" value={query} onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search the registry to add a member from the barangay paper list…"
                    aria-label="Search members to add" />
                </div>
                {candidates.length > 0 && (
                  <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-white">
                    {candidates.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">
                            {c.first_name} {c.middle_name} {c.last_name}
                          </p>
                          <p className="text-xs text-ink-soft">
                            {c.reference_no} · {c.barangay_name ?? 'no barangay'}{c.classification_code ? ` · ${c.classification_code}` : ''}
                          </p>
                        </div>
                        {listedIds.has(c.id)
                          ? <Badge>Already listed</Badge>
                          : <Button size="sm" variant="secondary" onClick={() => startAdd(c)}>Add</Button>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>

          <DataTable
            rows={beneficiaries}
            columns={columns}
            rowKey={(b) => b.id}
            exportName={`subsidy-${open.name.replace(/\s+/g, '-').toLowerCase()}`}
            exportTitle={`Subsidy beneficiaries — ${open.name}`}
            emptyTitle="No beneficiaries yet"
            emptyMessage="Search the registry above and add members as you cross-check the barangay paper list."
            renderActions={canManage ? (b) => (
              <Button size="sm" variant="ghost" className="text-red-700" onClick={() => { setRemoving(b); setRemoveReason('') }}>
                Remove
              </Button>
            ) : undefined}
          />
        </>
      )}

      <Modal open={creating || !!editing} title={editing ? 'Edit programme' : 'New subsidy programme'}
        onClose={() => { setCreating(false); setEditing(null) }}
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCreating(false); setEditing(null) }}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void saveProgram()}>Save programme</Button>
          </>
        }>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Programme name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Bigasan 2026" />
          </Field>
          <Field label="Description">
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Rice subsidy, Q3 distribution" />
          </Field>
          <Field label="Period start">
            <input className="input" type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
          </Field>
          <Field label="Period end">
            <input className="input" type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active (accepting new beneficiaries)
          </label>
        </div>
      </Modal>

      <Modal open={!!adding} title={`Add to ${open?.name ?? ''}`}
        onClose={() => setAdding(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void confirmAdd()}>Add to list</Button>
          </>
        }>
        {adding && (
          <div className="grid grid-cols-1 gap-3">
            <p className="text-sm text-ink">
              <strong>{adding.first_name} {adding.middle_name} {adding.last_name}</strong> · {adding.reference_no} · {adding.barangay_name ?? 'no barangay'}
            </p>
            <Field label="Classification code">
              <select className="input" value={addForm.classification_code}
                onChange={(e) => setAddForm({ ...addForm, classification_code: e.target.value })}>
                {CLASSIFICATION_CODES.map((c) => <option key={c.code} value={c.code}>{c.code ? `${c.code} — ${c.label}` : c.label}</option>)}
              </select>
            </Field>
            <Field label="Paper list reference">
              <input className="input" value={addForm.paper_ref} onChange={(e) => setAddForm({ ...addForm, paper_ref: e.target.value })}
                placeholder="Brgy San Juan list, row 12" />
            </Field>
            <Field label="Notes">
              <input className="input" value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                placeholder="ID checked against paper list" />
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={addForm.verified} onChange={(e) => setAddForm({ ...addForm, verified: e.target.checked })} />
              Cross-checked against the barangay paper list
            </label>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!removing}
        title="Remove from programme list"
        message={removing ? `Remove ${removing.person_name} from ${open?.name}? The removal is written to the audit log with your reason.` : ''}
        requireReason
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async (reason) => { await confirmRemove(reason); }}
      />
    </>
  )
}
