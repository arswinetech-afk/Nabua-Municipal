import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { MatchCard } from '../components/DuplicateMatch'
import type { ApiResult, PersonDetail, PersonInput } from '../lib/api'
import { CLASSIFICATION_CODES, type Barangay, type Person, type PersonIndexRow, type PersonStatus, type TransferReason } from '../lib/types'
import { PERSON_STATUSES } from '../lib/types'
import type { DuplicateMatch, PersonComparable } from '../lib/duplicateEngine'
import { normalizeDate } from '../lib/normalize'
import { ageFrom } from '../lib/duplicateEngine'
import { cn, formatDate, formatDateTime, relativeTime } from '../lib/utils'
import { fullName, maskContact } from '../lib/normalize'
import {
  Badge, Button, Card, CopyButton, Field, IconAlert, IconArrowLeft, IconArrowRight, IconCheck, IconClock,
  IconCopy, IconEdit, IconEye, IconHistory, IconMerge, IconPerson, IconRefresh, IconSave, IconShieldCheck,
  IconUserCheck, IconUsers, IconUserX, MatchBadge, Modal, Skeleton, StatusBadge, useToast,
} from '../components/ui'

const TRANSFER_REASONS: Array<{ value: TransferReason; label: string; hint: string }> = [
  { value: 'RESIDENT_TRANSFER', label: 'Resident transfer', hint: 'The resident genuinely moved to another barangay.' },
  { value: 'ADMINISTRATIVE_CORRECTION', label: 'Administrative correction', hint: 'The barangay was encoded wrongly and is being corrected.' },
  { value: 'OTHER', label: 'Other', hint: 'Explain the reason in the notes — it is stored in the audit trail.' },
]

type DialogState =
  | { kind: 'none' }
  | { kind: 'edit' }
  | { kind: 'transfer' }
  | { kind: 'status' }
  | { kind: 'decision'; match: DuplicateMatch | null; case_id?: string }
  | { kind: 'merge'; match: DuplicateMatch }

export default function MemberProfile() {
  const { id = '' } = useParams()
  const { api, user, settings, online } = useApp()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const toast = useToast()

  const [person, setPerson] = useState<PersonDetail | null>(null)
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })
  const [foundMatch, setFoundMatch] = useState<DuplicateMatch | null>(null)
  const [notFound, setNotFound] = useState(false)

  const [editForm, setEditForm] = useState<Record<string, string>>({})
  const [editReason, setEditReason] = useState('')
  const [transferForm, setTransferForm] = useState({ barangay_id: '', reason: 'RESIDENT_TRANSFER' as TransferReason, effective_date: '', notes: '' })
  const [statusForm, setStatusForm] = useState<{ status: PersonStatus; reason: string }>({ status: 'ACTIVE', reason: '' })
  const [decisionNotes, setDecisionNotes] = useState('')
  const [mergeResolved, setMergeResolved] = useState<Record<string, string>>({})
  const [mergeReason, setMergeReason] = useState('')
  const [busy, setBusy] = useState(false)

  const canEdit = user && ['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)
  /** Transfers, status changes and merges are administrator functions in the database too. */
  const canResolve = user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const [detail, brgys] = await Promise.all([api.getPerson(id), api.listBarangays(true)])
      setPerson(detail)
      setBarangays(brgys)
      setNotFound(!detail)
      if (detail) {
        setStatusForm({ status: detail.status, reason: '' })
        setTransferForm((f) => ({ ...f, barangay_id: brgys.find((b) => b.id !== detail.barangay_id)?.id ?? '' }))
      }
    } finally {
      setLoading(false)
    }
  }, [api, id])

  useEffect(() => {
    void load()
  }, [load, online])

  // live duplicate re-check for this record (used by the DUPLICATE CHECK section)
  useEffect(() => {
    if (!person || person.status === 'ARCHIVED') return
    let cancelled = false
    void (async () => {
      const matches = await api.checkDuplicates({
        id: person.id, first_name: person.first_name, middle_name: person.middle_name, last_name: person.last_name,
        suffix: person.suffix, date_of_birth: person.date_of_birth, sex: person.sex, purok: person.purok,
        address: person.address, contact_number: person.contact_number, barangay_id: person.barangay_id,
        barangay_name: person.barangay_name ?? null,
      }, person.id).catch(() => [])
      if (!cancelled) setFoundMatch(matches[0] ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [api, person, person?.updated_at])

  const openEdit = () => {
    if (!person) return
    setEditForm({
      first_name: person.first_name, middle_name: person.middle_name ?? '', last_name: person.last_name,
      suffix: person.suffix ?? '', date_of_birth: person.date_of_birth ?? '', sex: person.sex ?? '',
      civil_status: person.civil_status ?? '', contact_number: person.contact_number ?? '',
      classification_code: person.classification_code ?? '',
      tags: (person.tags ?? []).join(', '), occupation: person.occupation ?? '',
      purok: person.purok ?? '', address: person.address ?? '', remarks: person.remarks ?? '',
    })
    setEditReason('')
    setDialog({ kind: 'edit' })
  }

  const saveEdit = async () => {
    if (!person) return
    if (settings.require_reason_on_edit && !editReason.trim()) {
      toast.push({ tone: 'error', title: 'A reason is required', message: 'Edits are audited with the reason you give.' })
      return
    }
    setBusy(true)
    if (editForm.date_of_birth && !normalizeDate(editForm.date_of_birth)) {
      setBusy(false)
      toast.push({ tone: 'error', title: 'Invalid birthdate', message: 'Use MM/DD/YYYY or YYYY-MM-DD.' })
      return
    }
    const patch: Partial<PersonInput> = {
      first_name: editForm.first_name, middle_name: editForm.middle_name || null, last_name: editForm.last_name,
      suffix: editForm.suffix || null, date_of_birth: normalizeDate(editForm.date_of_birth) || null,
      sex: editForm.sex || null, civil_status: editForm.civil_status || null,
      contact_number: editForm.contact_number || null, classification_code: editForm.classification_code || null,
      tags: (editForm.tags ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean),
      occupation: editForm.occupation || null,
      purok: editForm.purok || null,
      address: editForm.address || null, remarks: editForm.remarks || null,
    }
    const res: ApiResult<Person> = await api.updatePerson(person.id, patch, editReason.trim())
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Update refused', message: res.error })
      return
    }
    toast.push({ tone: 'success', title: 'Record updated', message: 'Previous and new values are in the audit trail.' })
    setDialog({ kind: 'none' })
    await load()
  }

  const doTransfer = async () => {
    if (!person) return
    if (!transferForm.barangay_id) return
    if (!transferForm.reason) return
    if (transferForm.reason === 'OTHER' && !transferForm.notes.trim()) {
      toast.push({ tone: 'error', title: 'Notes are required', message: 'Choose “Other” only with an explanation.' })
      return
    }
    setBusy(true)
    const res = await api.transferBarangay({
      person_id: person.id,
      barangay_id: transferForm.barangay_id,
      reason: transferForm.reason,
      effective_date: normalizeDate(transferForm.effective_date) || undefined,
      notes: transferForm.notes || undefined,
    })
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Transfer refused', message: res.error })
      return
    }
    toast.push({ tone: 'success', title: 'Barangay transfer recorded', message: 'The previous assignment is kept in the history.' })
    setDialog({ kind: 'none' })
    setTransferForm({ barangay_id: '', reason: 'RESIDENT_TRANSFER', effective_date: '', notes: '' })
    await load()
  }

  const doStatus = async () => {
    if (!person) return
    if (!statusForm.reason.trim()) {
      toast.push({ tone: 'error', title: 'A reason is required', message: 'Every status change is explained in the audit log.' })
      return
    }
    setBusy(true)
    const res = await api.setPersonStatus(person.id, statusForm.status, statusForm.reason.trim())
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Status change refused', message: res.error })
      return
    }
    toast.push({ tone: 'success', title: `Status set to ${statusForm.status.replace('_', ' ')}`, message: 'Nothing was deleted — records are only reclassified.' })
    setDialog({ kind: 'none' })
    await load()
  }

  const decide = async (resolution: 'DIFFERENT_PERSON' | 'KEPT_BOTH' | 'DEFERRED', caseId: string) => {
    setBusy(true)
    const res = await api.resolveDuplicateCase(caseId, resolution, decisionNotes.trim())
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Decision could not be saved', message: res.error })
      return
    }
    toast.push({
      tone: 'success',
      title: 'Decision recorded',
      message: resolution === 'DIFFERENT_PERSON' ? 'Marked as different people.' : resolution === 'KEPT_BOTH' ? 'Both records kept.' : 'Set aside for later investigation.',
    })
    setDialog({ kind: 'none' })
    setDecisionNotes('')
    await load()
  }

  const doMerge = async (keepId: string, mergeId: string) => {
    if (!mergeReason.trim()) {
      toast.push({ tone: 'error', title: 'A reason is required to merge' })
      return
    }
    setBusy(true)
    const res = await api.mergePersons(keepId, mergeId, { resolved: mergeResolved, reason: mergeReason.trim(), confirm: true })
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Merge refused', message: res.error })
      return
    }
    toast.push({ tone: 'success', title: 'Records merged', message: 'The losing record is archived and keeps its audit trail — nothing was deleted.' })
    setDialog({ kind: 'none' })
    setMergeResolved({})
    setMergeReason('')
    await load()
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (notFound || !person) {
    return (
      <Card className="card-pad mx-auto max-w-lg text-center">
        <IconAlert className="mx-auto h-8 w-8 text-amber-600" />
        <h1 className="mt-2 text-base font-bold">Member record not found</h1>
        <p className="mt-1 text-xs text-ink-soft">
          The record may have been merged into another master record, or it belongs to a barangay outside your scope.
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/members')}>Back to members</Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/duplicates')}>Open Duplicate Center</Button>
        </div>
      </Card>
    )
  }

  const openCases = person.duplicates.filter((d) => d.status === 'PENDING')
  const currentBarangay = barangays.find((b) => b.id === person.barangay_id)
  const age = ageFrom(person.date_of_birth)

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Members', to: '/members' },
          { label: person.barangay_name ?? 'Unassigned', to: `/barangays/${person.barangay_id ?? ''}` },
          { label: fullName(person) },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {fullName(person)} {person.suffix ?? ''}
            <StatusBadge status={person.status} />
            {openCases.length > 0 && <Badge tone="danger">{openCases.length} duplicate case(s)</Badge>}
            {(person.tags ?? []).map((t) => <Badge key={t} tone="info">{t}</Badge>)}
          </span>
        }
        subtitle={
          <span className="mono">
            {person.reference_no} · {currentBarangay?.name ?? 'No barangay'} · created {formatDate(person.created_at)} · updated {relativeTime(person.updated_at)}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}><IconArrowLeft /> Back</Button>
            <Button variant="secondary" size="sm" onClick={() => void load()}><IconRefresh /> Refresh</Button>
            {canResolve && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: 'transfer' })}>
                  <IconArrowRight /> Transfer barangay
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: 'status' })}>
                  <IconHistory /> Change status
                </Button>
              </>
            )}
            {canEdit && <Button variant="primary" size="sm" onClick={openEdit}><IconEdit /> Edit record</Button>}
          </>
        }
      />

      {params.get('mode') === 'existing' && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-gov-200 bg-gov-50 px-3 py-2 text-xs text-gov-900">
          <IconUserCheck className="mt-0.5" />
          <span>
            You chose to continue from this existing record instead of creating a duplicate. Update the details below,
            or transfer the barangay if the resident has moved.
          </span>
        </div>
      )}

      {person.merged_into && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <IconMerge />
          <span>This record was merged into another master record and is kept for history only.</span>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/members/${person.merged_into}`)}>Open surviving record</Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* ------------------------------------------------ PERSONAL */}
          <Card>
            <div className="card-header">
              <h2 className="section-title"><IconPerson /> Personal information</h2>
              <span className="text-[11px] text-ink-soft">Master record — every barangay sees the same data</span>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-3">
              <Detail label="First name" value={person.first_name} />
              <Detail label="Middle name" value={person.middle_name} empty="Not recorded" warn />
              <Detail label="Last name" value={person.last_name} />
              <Detail label="Suffix" value={person.suffix} empty="—" />
              <Detail label="Date of birth" value={person.date_of_birth ? `${formatDate(person.date_of_birth)}${age != null ? ` (${age} yrs)` : ''}` : ''} empty="Not recorded" warn />
              <Detail label="Sex" value={person.sex ? (person.sex === 'MALE' ? 'Male' : 'Female') : ''} empty="Not recorded" warn />
              <Detail label="Civil status" value={person.civil_status} empty="Not recorded" />
              <Detail label="Reference number" value={person.reference_no} mono />
              <Detail label="Record status" value={person.status.replace('_', ' ')} />
            </dl>
          </Card>

          {/* ------------------------------------------------ ADDRESS + CONTACT */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <div className="card-header"><h2 className="section-title">Address</h2></div>
              <dl className="space-y-3 px-4 py-4">
                <Detail label="Barangay" value={person.barangay_name} empty="Not assigned" warn />
                <Detail label="Purok / Sitio" value={person.purok} empty="Not recorded" />
                <Detail label="Complete address" value={person.address} empty="Not recorded" warn multiline />
              </dl>
            </Card>
            <Card>
              <div className="card-header"><h2 className="section-title">Contact</h2></div>
              <dl className="space-y-3 px-4 py-4">
                <Detail
                  label="Contact number"
                  value={person.contact_number ? (settings.mask_contact_in_lists ? maskContact(person.contact_number) : person.contact_number) : ''}
                  empty="Not recorded"
                  warn={!person.contact_number || person.contact_number.replace(/\D/g, '').length < 7}
                />
                <Detail label="Household" value={person.household_name} empty="Not linked to a household" />
                <Detail label="Remarks" value={person.remarks} empty="—" multiline />
              </dl>
            </Card>
          </div>

          {/* ------------------------------------------------ BARANGAY HISTORY */}
          <Card>
            <div className="card-header">
              <h2 className="section-title"><IconHistory /> Barangay history</h2>
              <span className="text-[11px] text-ink-soft">{person.history.length} assignment(s) recorded</span>
            </div>
            {person.history.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-ink-soft">No barangay assignment has been recorded yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Barangay</th><th>From</th><th>To</th><th>Status</th><th>Reason</th><th>Recorded</th><th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {person.history.map((h) => (
                      <tr key={h.id}>
                        <td className="font-medium text-ink">
                          {h.barangay_name}
                          {!h.effective_to && <Badge tone="success" className="ml-2">Current</Badge>}
                        </td>
                        <td>{formatDate(h.effective_from)}</td>
                        <td>{h.effective_to ? formatDate(h.effective_to) : '—'}</td>
                        <td><StatusBadge status={h.status} /></td>
                        <td className="text-xs">
                          {h.reason ? h.reason.replace(/_/g, ' ').toLowerCase() : '—'}
                          {h.notes ? <span className="block text-ink-soft">{h.notes}</span> : null}
                        </td>
                        <td className="text-xs text-ink-soft">{relativeTime(h.created_at)}</td>
                        <td className="text-xs text-ink-soft">{h.created_by_name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="border-t border-line px-4 py-3 text-[11px] text-ink-soft">
              Transfers never create a second person record — the resident keeps this reference number
              {' '}(<span className="mono">{person.reference_no}</span>).
            </div>
          </Card>

          {/* ------------------------------------------------ DUPLICATE CHECK */}
          <Card>
            <div className="card-header">
              <h2 className="section-title"><IconCopy /> Duplicate check</h2>
              <span className="text-[11px] text-ink-soft">
                {openCases.length > 0 ? `${openCases.length} open case(s)` : 'No open cases'}
              </span>
            </div>
            <div className="card-pad space-y-3">
              {foundMatch && (
                <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3">
                  <p className="text-[11px] font-semibold text-amber-900 uppercase">Closest live match in the registry</p>
                  <div className="mt-2"><MatchCard match={foundMatch} actions={false} /></div>
                </div>
              )}
              {person.duplicates.length === 0 && !foundMatch && (
                <p className="text-xs text-ink-soft">
                  This record has no known duplicates. The registry re-checks every save against name, birthdate, sex,
                  barangay, purok, address and contact number.
                </p>
              )}
              {person.duplicates.map((d) => (
                <div key={d.id} className="rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">
                        {fullName(d.other_person)} <span className="text-ink-soft">· {d.other_person.barangay_name ?? '—'}</span>
                      </p>
                      <p className="text-[11px] text-ink-soft">
                        Matched on {d.matching_fields?.join(', ') || 'multiple fields'} · opened {relativeTime(d.created_at)}
                        {d.reviewed_by_name ? ` · reviewed by ${d.reviewed_by_name}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <MatchBadge band={d.match_band} score={d.match_score} />
                      <StatusBadge status={d.status} />
                    </div>
                  </div>
                  {d.notes && <p className="mt-2 text-[11px] text-ink-soft">Note: {d.notes}</p>}

                  {canEdit && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => navigate(`/duplicates?case=${d.id}`)}>
                        <IconEye /> Side-by-side compare
                      </Button>
                      {canResolve && d.status === 'PENDING' && (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'decision', match: null, case_id: d.id })}>
                            Resolve…
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setMergeReason('')
                              setMergeResolved({})
                              setDialog({ kind: 'merge', match: { person: d.other_person, score: { score: d.match_score, band: d.match_band as never, reasons: [], flags: {} as never, weights: {} as never } } as unknown as DuplicateMatch })
                            }}
                          >
                            <IconMerge /> Merge…
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* ------------------------------------------------ RECORD HISTORY */}
          <Card>
            <div className="card-header"><h2 className="section-title"><IconClock /> Record history</h2></div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>When</th><th>Action</th><th>By</th><th>Reason</th><th>Reference</th></tr></thead>
                <tbody>
                  {person.audit.slice(0, 40).map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap text-xs">{formatDateTime(a.timestamp)}</td>
                      <td><Badge tone={actionTone(a.action)}>{a.action.replace(/_/g, ' ')}</Badge></td>
                      <td className="text-xs">{a.user_name ?? 'System'}</td>
                      <td className="text-xs text-ink-soft">{a.reason ?? '—'}</td>
                      <td className="text-xs">
                        <CopyButton value={a.id} label="ID" />
                      </td>
                    </tr>
                  ))}
                  {person.audit.length === 0 && (
                    <tr><td colSpan={5} className="py-6 text-center text-xs text-ink-soft">No audit entries yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------ SIDE COLUMN */}
        <div className="space-y-4">
          <Card className="card-pad">
            <h2 className="section-title">Identity summary</h2>
            <div className="mt-3 space-y-2 text-xs">
              <Row label="Reference no." value={<span className="mono">{person.reference_no}</span>} />
              <Row label="Identity key" value={<span className="mono">{identityHint(person)}</span>} />
              <Row label="Age" value={age != null ? `${age} years` : 'unknown'} />
              <Row label="Created by" value={person.created_by_name ?? '—'} />
              <Row label="Last edited by" value={person.updated_by_name ?? '—'} />
              <Row label="Last update" value={relativeTime(person.updated_at)} />
            </div>
            <p className="mt-3 text-[11px] text-ink-soft">
              The identity key is the database-level guard. Two records with the same key are refused, which is how
              simultaneous submissions are stopped.
            </p>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title">Household</h2>
            {person.household ? (
              <div className="mt-2 space-y-2 text-xs">
                <Row label="Household no." value={<span className="mono">{person.household.household_no}</span>} />
                <Row label="Head" value={person.household.head_name ?? '—'} />
                <Row label="Members" value={String(person.household.member_count ?? 0)} />
                <Row label="Purok" value={person.household.purok ?? '—'} />
                <Row label="Address" value={person.household.address ?? '—'} />
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-soft">
                Not linked to a household. Household grouping is optional and never blocks a member record.
              </p>
            )}
          </Card>

          {person.merged_from.length > 0 && (
            <Card className="card-pad">
              <h2 className="section-title">Merged into this record</h2>
              <ul className="mt-2 space-y-2 text-xs">
                {person.merged_from.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span>
                      {fullName(m)} <span className="text-ink-soft">· {m.reference_no}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => navigate(`/members/${m.id}`)}>Open</Button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-ink-soft">
                Archived source records keep their history and can be opened for reference, but they are never shown as
                separate members.
              </p>
            </Card>
          )}

          <Card className="card-pad">
            <h2 className="section-title"><IconShieldCheck /> Privacy notice</h2>
            <p className="mt-2 text-[11px] text-ink-soft">
              Access to this record is logged with your name, the action, the previous and new values and the time.
              Share member information only with authorised municipal staff.
            </p>
          </Card>
        </div>
      </div>

      {/* ------------------------------------------------ EDIT */}
      <Modal
        open={dialog.kind === 'edit'}
        onClose={() => setDialog({ kind: 'none' })}
        title="Edit member record"
        description="Previous values are preserved in the audit trail. Nothing is overwritten silently."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog({ kind: 'none' })}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void saveEdit()}><IconSave /> Save changes</Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First name" required>
            <input className="input" value={editForm.first_name ?? ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
          </Field>
          <Field label="Middle name">
            <input className="input" value={editForm.middle_name ?? ''} onChange={(e) => setEditForm({ ...editForm, middle_name: e.target.value })} />
          </Field>
          <Field label="Last name" required>
            <input className="input" value={editForm.last_name ?? ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
          </Field>
          <Field label="Suffix">
            <input className="input" value={editForm.suffix ?? ''} onChange={(e) => setEditForm({ ...editForm, suffix: e.target.value })} />
          </Field>
          <Field label="Date of birth" hint="MM/DD/YYYY or YYYY-MM-DD">
            <input className="input" value={editForm.date_of_birth ?? ''} onChange={(e) => setEditForm({ ...editForm, date_of_birth: e.target.value })} />
          </Field>
          <Field label="Sex">
            <select className="input" value={editForm.sex ?? ''} onChange={(e) => setEditForm({ ...editForm, sex: e.target.value })}>
              <option value="">Not recorded</option>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
            </select>
          </Field>
          <Field label="Civil status">
            <input className="input" value={editForm.civil_status ?? ''} onChange={(e) => setEditForm({ ...editForm, civil_status: e.target.value })} />
          </Field>
          <Field label="Tags" hint="Comma-separated; from barangay paper lists (FAMILY LEADER, AKAP, …).">
            <input className="input" value={editForm.tags ?? ''} onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })} placeholder="FAMILY LEADER, AKAP" />
          </Field>
          <Field label="Occupation">
            <input className="input" value={editForm.occupation ?? ''} onChange={(e) => setEditForm({ ...editForm, occupation: e.target.value })} />
          </Field>
          <Field label="Classification">
            <select className="input" value={editForm.classification_code ?? ''} onChange={(e) => setEditForm({ ...editForm, classification_code: e.target.value })}>
              {CLASSIFICATION_CODES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Contact number">
            <input className="input" value={editForm.contact_number ?? ''} onChange={(e) => setEditForm({ ...editForm, contact_number: e.target.value })} />
          </Field>
          <Field label="Purok / Sitio">
            <input className="input" value={editForm.purok ?? ''} onChange={(e) => setEditForm({ ...editForm, purok: e.target.value })} />
          </Field>
          <Field label="Complete address">
            <input className="input" value={editForm.address ?? ''} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
          </Field>
          <Field label="Remarks" className="sm:col-span-2">
            <textarea className="input" rows={2} value={editForm.remarks ?? ''} onChange={(e) => setEditForm({ ...editForm, remarks: e.target.value })} />
          </Field>
          <Field
            label="Reason for this edit"
            required={settings.require_reason_on_edit}
            hint="Stored with the audit entry, e.g. “Correction after verification with the barangay secretary”."
            className="sm:col-span-2"
          >
            <textarea className="input" rows={2} value={editReason} onChange={(e) => setEditReason(e.target.value)} />
          </Field>
        </div>
      </Modal>

      {/* ------------------------------------------------ TRANSFER */}
      <Modal
        open={dialog.kind === 'transfer'}
        onClose={() => setDialog({ kind: 'none' })}
        title="Transfer to another barangay"
        description="The same person keeps the same master record; only the assignment changes."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog({ kind: 'none' })}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!transferForm.barangay_id} onClick={() => void doTransfer()}>
              <IconArrowRight /> Record transfer
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md border border-line bg-slate-50 p-3 text-xs">
            <p><span className="font-semibold">Current barangay:</span> {person.barangay_name ?? 'not assigned'}</p>
            <p className="mono mt-1">{person.reference_no} · {fullName(person)}</p>
          </div>
          <Field label="New barangay" required>
            <select className="input" value={transferForm.barangay_id} onChange={(e) => setTransferForm({ ...transferForm, barangay_id: e.target.value })}>
              <option value="">Select barangay…</option>
              {barangays.filter((b) => b.id !== person.barangay_id && b.active).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Reason" required hint="A reason is always required — transfers are audited.">
            <div className="space-y-2">
              {TRANSFER_REASONS.map((r) => (
                <label key={r.value} className={cn('flex cursor-pointer gap-2 rounded-md border p-2.5 text-xs', transferForm.reason === r.value ? 'border-gov-400 bg-gov-50' : 'border-line')}>
                  <input
                    type="radio"
                    name="transfer-reason"
                    className="mt-0.5"
                    checked={transferForm.reason === r.value}
                    onChange={() => setTransferForm({ ...transferForm, reason: r.value })}
                  />
                  <span>
                    <span className="block font-semibold text-ink">{r.label}</span>
                    <span className="text-ink-soft">{r.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Effective date" hint="Defaults to today when left blank.">
              <input className="input" type="date" value={transferForm.effective_date} onChange={(e) => setTransferForm({ ...transferForm, effective_date: e.target.value })} />
            </Field>
            <Field label={transferForm.reason === 'OTHER' ? 'Notes (required for “Other”)' : 'Notes'}>
              <input className="input" value={transferForm.notes} onChange={(e) => setTransferForm({ ...transferForm, notes: e.target.value })} />
            </Field>
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------ STATUS */}
      <Modal
        open={dialog.kind === 'status'}
        onClose={() => setDialog({ kind: 'none' })}
        title="Change record status"
        description="Records are never deleted. Statuses describe the resident's situation."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog({ kind: 'none' })}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void doStatus()}><IconCheck /> Apply status</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="New status" required>
            <select className="input" value={statusForm.status} onChange={(e) => setStatusForm({ ...statusForm, status: e.target.value as PersonStatus })}>
              {PERSON_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </Field>
          <Field label="Reason" required hint="Required for every status change.">
            <textarea className="input" rows={2} value={statusForm.reason} onChange={(e) => setStatusForm({ ...statusForm, reason: e.target.value })}
              placeholder="e.g. Resident confirmed deceased by the barangay secretary." />
          </Field>
          <p className="text-[11px] text-ink-soft">
            Choosing <span className="font-semibold">Archived</span> hides the record from the active registry while
            keeping the history intact. Duplicate cases remain linked.
          </p>
        </div>
      </Modal>

      {/* ------------------------------------------------ DECISION */}
      <Modal
        open={dialog.kind === 'decision'}
        onClose={() => setDialog({ kind: 'none' })}
        title="Resolve duplicate case"
        description="Record your decision so the next encoder sees it."
        footer={<Button variant="ghost" onClick={() => setDialog({ kind: 'none' })}>Close</Button>}
      >
        <div className="space-y-3">
          <Field label="Notes" hint="Explain the evidence you used (documents checked, person interviewed, and so on).">
            <textarea className="input" rows={3} value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {dialog.kind === 'decision' && dialog.case_id && (
              <>
                <Button variant="primary" loading={busy} onClick={() => void decide('DIFFERENT_PERSON', dialog.case_id!)}>
                  <IconUserX /> Mark as different people
                </Button>
                <Button variant="secondary" loading={busy} onClick={() => void decide('KEPT_BOTH', dialog.case_id!)}>
                  <IconUsers /> Keep both
                </Button>
                <Button variant="ghost" loading={busy} onClick={() => void decide('DEFERRED', dialog.case_id!)}>
                  <IconClock /> Investigate later
                </Button>
              </>
            )}
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------ MERGE */}
      <Modal
        open={dialog.kind === 'merge'}
        onClose={() => setDialog({ kind: 'none' })}
        title="Merge duplicate records"
        description="Choose the surviving record and the value to keep for each field. The other record is archived, never deleted."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog({ kind: 'none' })}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                if (dialog.kind !== 'merge') return
                const otherId = dialog.match.person.id
                void doMerge(person.id, otherId)
              }}
            >
              <IconMerge /> Confirm merge
            </Button>
          </>
        }
      >
        {dialog.kind === 'merge' && (
          <MergePanel
            keep={person}
            merge={dialog.match.person}
            resolved={mergeResolved}
            onResolved={setMergeResolved}
            reason={mergeReason}
            onReason={setMergeReason}
          />
        )}
      </Modal>
    </>
  )
}

type MergePerson = Person | PersonIndexRow | PersonComparable
function referenceOf(p: MergePerson): string {
  return 'reference_no' in p && p.reference_no ? String(p.reference_no) : 'no reference yet'
}

type MergeField = 'first_name' | 'middle_name' | 'last_name' | 'suffix' | 'date_of_birth' | 'sex'
  | 'civil_status' | 'contact_number' | 'purok' | 'address' | 'remarks'

function MergePanel({
  keep, merge, resolved, onResolved, reason, onReason,
}: {
  keep: MergePerson
  merge: MergePerson
  resolved: Record<string, string>
  onResolved: (v: Record<string, string>) => void
  reason: string
  onReason: (v: string) => void
}) {
  const fields: Array<{ key: MergeField; label: string }> = [
    { key: 'first_name', label: 'First name' },
    { key: 'middle_name', label: 'Middle name' },
    { key: 'last_name', label: 'Last name' },
    { key: 'suffix', label: 'Suffix' },
    { key: 'date_of_birth', label: 'Date of birth' },
    { key: 'sex', label: 'Sex' },
    { key: 'civil_status', label: 'Civil status' },
    { key: 'contact_number', label: 'Contact number' },
    { key: 'purok', label: 'Purok / Sitio' },
    { key: 'address', label: 'Address' },
    { key: 'remarks', label: 'Remarks' },
  ]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-emerald-300 bg-emerald-50/50 p-3">
          <p className="text-[11px] font-semibold text-emerald-800 uppercase">Surviving record (kept)</p>
          <p className="mt-1 text-sm font-bold text-ink">{fullName(keep)}</p>
          <p className="mono text-[11px] text-ink-soft">{referenceOf(keep)} · {keep.barangay_name ?? '—'}</p>
        </div>
        <div className="rounded-md border border-red-200 bg-red-50/40 p-3">
          <p className="text-[11px] font-semibold text-red-800 uppercase">Merged record (archived)</p>
          <p className="mt-1 text-sm font-bold text-ink">{fullName(merge)}</p>
          <p className="mono text-[11px] text-ink-soft">{referenceOf(merge)} · {merge.barangay_name ?? '—'}</p>
        </div>
      </div>

      <div className="rounded-md border border-line">
        <div className="grid grid-cols-12 gap-2 border-b border-line bg-slate-50 px-3 py-2 text-[10px] font-semibold text-ink-soft uppercase">
          <span className="col-span-3">Field</span><span className="col-span-4">Surviving</span>
          <span className="col-span-4">Merged record</span><span className="col-span-1">Use</span>
        </div>
        <div className="divide-y divide-line">
          {fields.map((f) => {
            const a = String((keep as Record<string, unknown>)[f.key] ?? '')
            const b = String((merge as Record<string, unknown>)[f.key] ?? '')
            const same = a === b
            const pick = resolved[f.key as string] ?? (same ? 'A' : a ? 'A' : 'B')
            return (
              <div key={String(f.key)} className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-xs">
                <span className="col-span-3 font-medium text-ink">{f.label}</span>
                <span className={cn('col-span-4 truncate', !a && 'text-ink-soft')}>{a || '—'}</span>
                <span className={cn('col-span-4 truncate', !b && 'text-ink-soft', a && b && !same && 'font-semibold text-amber-800')}>
                  {b || '—'}
                  {a && b && !same && <span className="ml-1 text-[10px] text-amber-700">(differs)</span>}
                </span>
                <span className="col-span-1">
                  <select
                    className="input px-1 py-1 text-[11px]"
                    value={pick}
                    onChange={(e) => onResolved({ ...resolved, [String(f.key)]: e.target.value })}
                    aria-label={`Choose value for ${f.label}`}
                  >
                    <option value="A">A</option>
                    <option value="B">B</option>
                  </select>
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <Field label="Reason for the merge" required hint="Both records keep their audit history; this reason is stored on the merge entry.">
        <textarea className="input" rows={2} value={reason} onChange={(e) => onReason(e.target.value)}
          placeholder="e.g. Same resident encoded twice by two barangays; verified with the barangay secretary." />
      </Field>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
        <p className="font-semibold">What happens on merge</p>
        <ul className="mt-1 list-inside list-disc space-y-0.5">
          <li>The surviving record keeps its reference number and gains the merged record’s barangay history.</li>
          <li>The merged record is archived with a link to the survivor — it is never deleted.</li>
          <li>The duplicate case is closed as MERGED and the merge is written to the audit log.</li>
        </ul>
      </div>
    </div>
  )
}

function Detail({ label, value, empty = '—', warn, multiline, mono }: {
  label: string; value?: string | null; empty?: string; warn?: boolean; multiline?: boolean; mono?: boolean
}) {
  const has = value != null && String(value).length > 0
  return (
    <div className={multiline ? 'sm:col-span-3' : ''}>
      <dt className="text-[11px] font-medium tracking-wide text-ink-soft uppercase">{label}</dt>
      <dd className={cn('mt-0.5 text-sm', mono && 'mono', !has && warn ? 'text-amber-700' : has ? 'text-ink' : 'text-ink-soft')}>
        {has ? value : empty}
      </dd>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  )
}

function actionTone(action: string): string {
  if (action.includes('CREATE') || action.includes('IMPORTED')) return 'success'
  if (action.includes('MERGE')) return 'info'
  if (action.includes('TRANSFER')) return 'info'
  if (action.includes('STATUS') || action.includes('DUPLICATE')) return 'warning'
  if (action.includes('LOGIN') || action.includes('LOGOUT')) return 'muted'
  return 'neutral'
}

/** Short, explainable identity hint (the full key lives in the database). */
function identityHint(p: Person): string {
  const bits = [p.last_name, p.first_name, p.date_of_birth ?? 'no-dob'].map((b) => String(b).slice(0, 3).toUpperCase())
  return `${bits.join('-')}…`
}
