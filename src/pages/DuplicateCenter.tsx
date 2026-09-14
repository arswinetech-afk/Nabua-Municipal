import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { MatchReasons } from '../components/DuplicateMatch'
import type { DuplicateComparison } from '../lib/api'
import type { Barangay, DuplicateCase, Person, PersonIndexRow } from '../lib/types'
import { cn, formatDate, relativeTime } from '../lib/utils'
import { fullName } from '../lib/normalize'
import {
  Badge, Button, Card, EmptyState, Field, IconAlert, IconCheck, IconClock, IconCopy, IconEye, IconMerge,
  IconRefresh, IconSpinner, IconUserX, IconUsers, MatchBadge, Modal, Progress, Skeleton, StatusBadge,
  useToast,
} from '../components/ui'

type Resolution = 'DIFFERENT_PERSON' | 'KEPT_BOTH' | 'DEFERRED'

export default function DuplicateCenter() {
  const { api, user, online } = useApp()
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()

  const [cases, setCases] = useState<DuplicateCase[]>([])
  const [total, setTotal] = useState(0)
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState(params.get('status') ?? 'PENDING')
  const [barangayId, setBarangayId] = useState(params.get('barangay') ?? '')
  const [minScore, setMinScore] = useState<number>(Number(params.get('min') ?? 60))
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [limit, setLimit] = useState(20)
  const [offset, setOffset] = useState(0)

  const [selected, setSelected] = useState<DuplicateCase | null>(null)
  const [comparison, setComparison] = useState<DuplicateComparison | null>(null)
  const [comparing, setComparing] = useState(false)
  const [decisionNotes, setDecisionNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeResolved, setMergeResolved] = useState<Record<string, string>>({})
  const [mergeReason, setMergeReason] = useState('')

  const canResolve = user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)

  useEffect(() => {
    const handle = setTimeout(() => { setDebounced(query.trim()); setOffset(0) }, 300)
    return () => clearTimeout(handle)
  }, [query])

  useEffect(() => {
    void api.listBarangays(true).then(setBarangays)
  }, [api])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.listDuplicateCases({
        status, barangay_id: barangayId || null, min_score: minScore, query: debounced || undefined,
        limit, offset,
      })
      setCases(res.rows)
      setTotal(res.total)
    } finally {
      setLoading(false)
    }
  }, [api, status, barangayId, minScore, debounced, limit, offset])

  useEffect(() => {
    void load()
  }, [load, online])

  useEffect(() => {
    const next = new URLSearchParams()
    if (status !== 'PENDING') next.set('status', status)
    if (barangayId) next.set('barangay', barangayId)
    if (minScore !== 60) next.set('min', String(minScore))
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, barangayId, minScore])

  // deep link from the dashboard: /duplicates?case=ID
  useEffect(() => {
    const caseId = params.get('case')
    if (!caseId || cases.length === 0) return
    const found = cases.find((c) => c.id === caseId)
    if (found) void openCompare(found)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, params])

  const openCompare = async (c: DuplicateCase) => {
    setSelected(c)
    setComparison(null)
    setDecisionNotes('')
    setComparing(true)
    const result = await api.comparePersons(c.person_id_a, c.person_id_b).catch(() => null)
    setComparison(result)
    setComparing(false)
  }

  const resolve = async (resolution: Resolution) => {
    if (!selected) return
    if (resolution === 'KEPT_BOTH' && !decisionNotes.trim()) {
      toast.push({ tone: 'error', title: 'Add a note', message: 'Explain why both records must stay.' })
      return
    }
    setBusy(true)
    const res = await api.resolveDuplicateCase(selected.id, resolution, decisionNotes.trim())
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Decision refused', message: res.error })
      return
    }
    toast.push({
      tone: 'success',
      title: resolution === 'DIFFERENT_PERSON' ? 'Marked as different people'
        : resolution === 'KEPT_BOTH' ? 'Both records kept' : 'Set aside for later investigation',
      message: 'The decision is visible to every barangay and stored in the audit log.',
    })
    setSelected(null)
    setComparison(null)
    await load()
  }

  const doMerge = async (keepId: string, mergeId: string, keepName: string) => {
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
    toast.push({ tone: 'success', title: 'Records merged', message: `Surviving record: ${keepName}. Nothing was deleted.` })
    setMergeOpen(false)
    setSelected(null)
    setComparison(null)
    setMergeResolved({})
    setMergeReason('')
    await load()
  }

  const counts = {
    pending: cases.filter((c) => c.status === 'PENDING').length,
    blocked: cases.filter((c) => c.match_band === 'VERY_LIKELY').length,
  }

  return (
    <>
      <PageHeader
        title="Duplicate Review Center"
        subtitle="Every flagged pair is decided by a human being. Merging archives the losing record with full history — nothing is ever deleted."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}>
            <IconRefresh /> Refresh
          </Button>
        }
      />

      <Card className="card-pad">
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by member name or reference number"
              aria-label="Filter duplicate cases"
            />
          </div>
          <select className="input max-w-[13rem]" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0) }}>
            <option value="ALL">All cases</option>
            <option value="PENDING">Pending review</option>
            <option value="MERGED">Merged</option>
            <option value="DIFFERENT_PERSON">Different people</option>
            <option value="KEPT_BOTH">Both kept</option>
            <option value="DEFERRED">Deferred</option>
          </select>
          <select className="input max-w-[14rem]" value={barangayId} onChange={(e) => { setBarangayId(e.target.value); setOffset(0) }}>
            <option value="">All barangays</option>
            {barangays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <Field label="Minimum match %" className="min-w-[10rem]">
            <input
              type="number" min={0} max={100} step={5}
              className="input"
              value={minScore}
              onChange={(e) => { setMinScore(Number(e.target.value)); setOffset(0) }}
            />
          </Field>
          <select className="input max-w-[8rem]" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0) }}>
            {[10, 20, 50].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-soft">
          <Badge tone="warning">{counts.pending} on this page pending</Badge>
          {counts.blocked > 0 && <Badge tone="danger">{counts.blocked} likely duplicate(s)</Badge>}
          <span>{total} case(s) match the filters.</span>
        </div>
      </Card>

      <div className="mt-4 space-y-3">
        {loading && (
          <>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </>
        )}

        {!loading && cases.length === 0 && (
          <Card>
            <EmptyState
              icon={<IconCheck className="h-6 w-6 text-emerald-600" />}
              title="No duplicate cases with these filters"
              message="Lower the minimum match percentage or clear the barangay filter. The engine keeps checking on every save."
            />
          </Card>
        )}

        {!loading && cases.map((c) => {
          const a = c.person_a
          const b = c.person_b
          return (
            <Card key={c.id} className={cn('card-pad', c.match_band === 'VERY_LIKELY' && 'border-red-200')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <MatchBadge band={c.match_band} score={c.match_score} />
                    <StatusBadge status={c.status} />
                    <span className="text-[11px] text-ink-soft">Opened {relativeTime(c.created_at)}</span>
                    {c.batch_id && <Badge tone="info">From an import batch</Badge>}
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <PersonMini person={a} label="Record A" />
                    <PersonMini person={b} label="Record B" />
                  </div>
                  <p className="mt-2 text-[11px] text-ink-soft">
                    Matching fields: <span className="font-medium text-ink">{c.matching_fields?.join(', ') || '—'}</span>
                  </p>
                  {c.notes && <p className="mt-1 text-[11px] text-ink-soft">Notes: {c.notes}</p>}
                  {c.reviewed_by_name && (
                    <p className="mt-1 text-[11px] text-ink-soft">
                      Reviewed by {c.reviewed_by_name} · {c.reviewed_at ? relativeTime(c.reviewed_at) : ''}
                    </p>
                  )}
                </div>
                <div className="flex w-full flex-col gap-1.5 sm:w-auto">
                  <Button variant="primary" size="sm" onClick={() => void openCompare(c)}>
                    <IconEye /> Compare side by side
                  </Button>
                  {a && (
                    <Button variant="secondary" size="sm" onClick={() => navigate(`/members/${a.id}`)}>
                      Open record A
                    </Button>
                  )}
                  {b && (
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/members/${b.id}`)}>
                      Open record B
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      {total > limit && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            Previous
          </Button>
          <span className="text-xs text-ink-soft">
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <Button variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
            Next
          </Button>
        </div>
      )}

      {/* ------------------------------------------------ side-by-side comparison */}
      <Modal
        open={!!selected}
        onClose={() => { setSelected(null); setComparison(null) }}
        title="Side-by-side comparison"
        description="Differences are highlighted. Decide with evidence: merge, mark as different people, keep both, or investigate later."
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setSelected(null); setComparison(null) }}>Close</Button>
            {canResolve && selected && (
              <>
                <Button variant="secondary" loading={busy} onClick={() => void resolve('DIFFERENT_PERSON')}>
                  <IconUserX /> Mark as different people
                </Button>
                <Button variant="secondary" loading={busy} onClick={() => void resolve('KEPT_BOTH')}>
                  <IconUsers /> Keep both
                </Button>
                <Button variant="ghost" loading={busy} onClick={() => void resolve('DEFERRED')}>
                  <IconClock /> Investigate later
                </Button>
                <Button
                  variant="danger"
                  disabled={comparison == null}
                  onClick={() => { setMergeResolved({}); setMergeReason(''); setMergeOpen(true) }}
                >
                  <IconMerge /> Merge records
                </Button>
              </>
            )}
          </>
        }
      >
        {comparing && (
          <div className="flex items-center gap-2 py-8 text-sm text-ink-soft">
            <IconSpinner /> Building the comparison…
          </div>
        )}

        {comparison && (
          <div className="space-y-4">
            <div className="rounded-md border border-line bg-slate-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-ink">
                    Overall confidence <MatchBadge band={comparison.band} score={comparison.score} />
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-soft">
                    {comparison.score}% weighted across the fields below. Every contributing field is listed with its
                    own comparison result.
                  </p>
                </div>
                <div className="w-40">
                  <Progress
                    value={comparison.score}
                    tone={comparison.score >= 95 ? 'danger' : comparison.score >= 80 ? 'warning' : 'info'}
                  />
                </div>
              </div>
              <div className="mt-3">
                <MatchReasons match={{ person: comparison.a, score: { reasons: comparison.reasons } } as never} />
              </div>
            </div>

            <div className="table-wrap rounded-md border border-line">
              <table className="table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Record A</th>
                    <th>Record B</th>
                    <th className="text-center">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.diff.map((row) => (
                    <tr key={row.field} className={cn(!row.same && 'bg-amber-50/50')}>
                      <td className="text-xs font-semibold text-ink">{row.label}</td>
                      <td className="text-xs">{String(row.a ?? '—')}</td>
                      <td className={cn('text-xs', !row.same && 'font-semibold text-amber-900')}>{String(row.b ?? '—')}</td>
                      <td className="text-center">
                        {row.same
                          ? <Badge tone="success">Same</Badge>
                          : <Badge tone="warning">Differs</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <PersonFacts person={comparison.a} label="Record A" onOpen={() => navigate(`/members/${comparison.a.id}`)} />
              <PersonFacts person={comparison.b} label="Record B" onOpen={() => navigate(`/members/${comparison.b.id}`)} />
            </div>

            {canResolve && (
              <Field label="Decision notes" hint="Explain the evidence used. Notes are stored with the case and the audit entry.">
                <textarea className="input" rows={3} value={decisionNotes} onChange={(e) => setDecisionNotes(e.target.value)} />
              </Field>
            )}
            {!canResolve && (
              <div className="flex items-start gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                <IconAlert className="mt-0.5" />
                <span>
                  Only Administrators and System Administrators can resolve a duplicate case. You can review the
                  comparison and open both records.
                </span>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------ merge */}
      <Modal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title="Merge duplicate records"
        description="Pick the surviving value for each field. There is no silent overwrite: every chosen value is recorded."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMergeOpen(false)}>Cancel</Button>
            {comparison && (
              <>
                <Button
                  variant="secondary"
                  loading={busy}
                  onClick={() => void doMerge(comparison.a.id, comparison.b.id, fullName(comparison.a))}
                >
                  Keep A · {fullName(comparison.a)}
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  onClick={() => void doMerge(comparison.b.id, comparison.a.id, fullName(comparison.b))}
                >
                  Keep B · {fullName(comparison.b)}
                </Button>
              </>
            )}
          </>
        }
      >
        {comparison && (
          <div className="space-y-3">
            <p className="text-xs text-ink-soft">
              Choose the survivor with the buttons below, then set the value to keep for every field that differs.
              The other record is archived with a pointer to the survivor and keeps its audit history.
            </p>
            <div className="rounded-md border border-line">
              <div className="grid grid-cols-12 gap-2 border-b border-line bg-slate-50 px-3 py-2 text-[10px] font-semibold text-ink-soft uppercase">
                <span className="col-span-4">Field</span><span className="col-span-3">Record A</span>
                <span className="col-span-3">Record B</span><span className="col-span-2">Keep</span>
              </div>
              <div className="divide-y divide-line">
                {comparison.diff.map((row) => {
                  const pick = mergeResolved[row.field] ?? 'A'
                  return (
                    <div key={row.field} className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-xs">
                      <span className="col-span-4 font-medium text-ink">{row.label}</span>
                      <span className={cn('col-span-3 truncate', !row.same && 'font-semibold text-amber-900')}>{String(row.a ?? '—')}</span>
                      <span className={cn('col-span-3 truncate', !row.same && 'font-semibold text-amber-900')}>{String(row.b ?? '—')}</span>
                      <span className="col-span-2">
                        <select
                          className="input px-1 py-1 text-[11px]"
                          value={pick}
                          onChange={(e) => setMergeResolved({ ...mergeResolved, [row.field]: e.target.value })}
                          aria-label={`Keep value for ${row.label}`}
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
            <Field label="Reason for the merge" required>
              <textarea className="input" rows={2} value={mergeReason} onChange={(e) => setMergeReason(e.target.value)}
                placeholder="e.g. Confirmed with the barangay secretary that both entries describe the same resident." />
            </Field>
          </div>
        )}
      </Modal>
    </>
  )
}

function PersonMini({ person, label }: { person?: PersonIndexRow; label: string }) {
  if (!person) {
    return (
      <div className="rounded-md border border-dashed border-line p-2 text-[11px] text-ink-soft">
        {label}: unavailable (record removed from view)
      </div>
    )
  }
  return (
    <div className="rounded-md border border-line p-2">
      <p className="text-[10px] font-semibold tracking-wide text-ink-soft uppercase">{label}</p>
      <p className="truncate text-sm font-semibold text-ink">{fullName(person)}</p>
      <p className="text-[11px] text-ink-soft">
        {person.barangay_name ?? '—'} · born {formatDate(person.date_of_birth)} · <span className="mono">{person.reference_no}</span>
      </p>
    </div>
  )
}

function PersonFacts({ person, label, onOpen }: { person: Person; label: string; onOpen: () => void }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-wide text-ink-soft uppercase">{label}</p>
        <Button size="sm" variant="ghost" onClick={onOpen}><IconCopy /> Open profile</Button>
      </div>
      <dl className="mt-2 space-y-1 text-[11px]">
        <Fact label="Name" value={fullName(person)} />
        <Fact label="Reference" value={person.reference_no} />
        <Fact label="Barangay" value={person.barangay_name ?? '—'} />
        <Fact label="Purok" value={person.purok ?? '—'} />
        <Fact label="Address" value={person.address ?? '—'} />
        <Fact label="Contact" value={person.contact_number ?? '—'} />
        <Fact label="Status" value={person.status.replace('_', ' ')} />
        <Fact label="Created" value={formatDate(person.created_at)} />
        <Fact label="Updated" value={relativeTime(person.updated_at)} />
      </dl>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="max-w-[65%] truncate text-right font-medium text-ink">{value}</dd>
    </div>
  )
}
