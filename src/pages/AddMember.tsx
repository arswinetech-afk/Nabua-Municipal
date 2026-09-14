/**
 * ADD MEMBER — the duplicate-prevention workflow (specification sections 5, 8, 22).
 *
 * Step 1: SEARCH EXISTING MEMBERS  (nothing is created yet)
 * Step 2: DETAILS                  (live duplicate checking while typing)
 * Step 3: REVIEW & SAVE            (blocked / warned / confirmed according to band)
 *
 * The Save button stays disabled while the duplicate check is running, and a
 * VER<span>Y</span>-LIKELY match cannot be saved at all without a written reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { LiveDuplicateIndicator, MatchCard } from '../components/DuplicateMatch'
import type { DuplicateMatch, MatchBand, PersonComparable } from '../lib/duplicateEngine'
import { BAND_META } from '../lib/duplicateEngine'
import type { Barangay, PersonIndexRow } from '../lib/types'
import { cn, formatDate, relativeTime } from '../lib/utils'
import { fullName, maskContact } from '../lib/normalize'
import { normalizeDate } from '../lib/normalize'
import {
  Badge, Button, Card, Field, IconAlert, IconArrowLeft, IconArrowRight, IconCheck, IconEye, IconPlus,
  IconSearch, IconSpinner, Modal, StatusBadge, useToast,
} from '../components/ui'

type FormState = {
  first_name: string
  middle_name: string
  last_name: string
  suffix: string
  date_of_birth: string
  sex: '' | 'MALE' | 'FEMALE'
  civil_status: string
  contact_number: string
  purok: string
  address: string
  barangay_id: string
  remarks: string
}

const EMPTY: FormState = {
  first_name: '', middle_name: '', last_name: '', suffix: '', date_of_birth: '', sex: '',
  civil_status: '', contact_number: '', purok: '', address: '', barangay_id: '', remarks: '',
}

const CIVIL = ['SINGLE', 'MARRIED', 'WIDOWED', 'SEPARATED', 'ANNULLED', 'UNKNOWN']

export default function AddMember() {
  const { api, user, settings } = useApp()
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [form, setForm] = useState<FormState>({ ...EMPTY, barangay_id: params.get('barangay') ?? '' })

  // step 1 state
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<PersonIndexRow[]>([])

  // live duplicate state
  const [matches, setMatches] = useState<DuplicateMatch[]>([])
  const [checking, setChecking] = useState(false)
  const [checkedOnce, setCheckedOnce] = useState(false)
  const [serverVerdict, setServerVerdict] = useState<MatchBand | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewedExisting, setReviewedExisting] = useState(false)
  const [samePerson, setSamePerson] = useState<{ id: string; name: string; barangay?: string | null } | null>(null)
  const [verdict, setVerdict] = useState<{
    band: MatchBand; score: number; matches: DuplicateMatch[]; code?: string; message?: string
  } | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const checkToken = useRef(0)

  useEffect(() => {
    void api.listBarangays().then(setBarangays)
  }, [api])

  const barangayName = barangays.find((b) => b.id === form.barangay_id)?.name ?? null

  const candidate: PersonComparable = useMemo(() => ({
    id: 'new',
    first_name: form.first_name,
    middle_name: form.middle_name || null,
    last_name: form.last_name,
    suffix: form.suffix || null,
    date_of_birth: normalizeDate(form.date_of_birth) || null,
    sex: form.sex || null,
    purok: form.purok || null,
    address: form.address || null,
    contact_number: form.contact_number || null,
    barangay_id: form.barangay_id || null,
    barangay_name: barangayName,
  }), [form, barangayName])

  // ---------------------------------------------------------------- debounced search (step 1)
  useEffect(() => {
    if (step !== 1) return
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    const handle = setTimeout(async () => {
      const res = await api.searchPersons({ query: q, limit: 8 })
      setResults(res.rows.map((p) => ({
        id: p.id, reference_no: p.reference_no, first_name: p.first_name, middle_name: p.middle_name,
        last_name: p.last_name, suffix: p.suffix, date_of_birth: p.date_of_birth, sex: p.sex,
        purok: p.purok, address: p.address, contact_number: p.contact_number,
        barangay_id: p.barangay_id, barangay_name: p.barangay_name ?? null, status: p.status,
        updated_at: p.updated_at,
      })))
      setSearching(false)
    }, 280)
    return () => clearTimeout(handle)
  }, [api, query, step])

  // ---------------------------------------------------------------- live duplicate check (step 2)
  const runCheck = useCallback(async () => {
    const enough = form.first_name.trim().length >= 2 && form.last_name.trim().length >= 2
    if (!enough) {
      setMatches([])
      setCheckedOnce(false)
      setServerVerdict(null)
      return
    }
    const token = ++checkToken.current
    setChecking(true)
    try {
      const found = await api.checkDuplicates(candidate)
      if (token !== checkToken.current) return
      setMatches(found)
      setServerVerdict(found[0]?.score.band ?? 'DISTINCT')
    } finally {
      if (token === checkToken.current) {
        setChecking(false)
        setCheckedOnce(true)
      }
    }
  }, [api, candidate, form.first_name, form.last_name])

  useEffect(() => {
    if (step !== 2) return
    const handle = setTimeout(() => void runCheck(), 420)
    return () => clearTimeout(handle)
  }, [runCheck, step])

  const band: MatchBand | null = matches[0]?.score.band ?? (checkedOnce ? 'DISTINCT' : null)
  const hasInput = form.first_name.trim().length > 0 || form.last_name.trim().length > 0
  const veryLikely = band === 'VERY_LIKELY'
  const blocking = veryLikely && settings.block_on_very_likely
  const requiresConfirmation = band === 'POSSIBLE' || band === 'POTENTIAL'
  // The Save control is disabled while the registry is being checked, and stays
  // disabled until the encoder acknowledges any match the engine reported.
  const needsAcknowledgement = veryLikely || requiresConfirmation
  const saveDisabled = saving || checking || !checkedOnce ||
    !form.first_name.trim() || !form.last_name.trim() ||
    (needsAcknowledgement && !reviewedExisting) ||
    (blocking && !overrideReason.trim())

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  const useExisting = (id: string, name: string, brgy?: string | null) => {
    setSamePerson({ id, name, barangay: brgy })
  }

  const submit = async () => {
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError('First name and last name are required.')
      return
    }
    if (form.date_of_birth && !normalizeDate(form.date_of_birth)) {
      setError('Date of birth is not a valid date. Use MM/DD/YYYY or YYYY-MM-DD.')
      return
    }
    setSaving(true)
    const confirmedDistinct = requiresConfirmation || veryLikely
    const res = await api.createPerson({
      ...form,
      middle_name: form.middle_name || null,
      suffix: form.suffix || null,
      date_of_birth: normalizeDate(form.date_of_birth) || null,
      sex: form.sex || null,
      civil_status: form.civil_status || null,
      contact_number: form.contact_number || null,
      purok: form.purok || null,
      address: form.address || null,
      barangay_id: form.barangay_id || null,
      remarks: form.remarks || null,
    } as never, {
      confirmedDistinct: confirmedDistinct && !!overrideReason.trim(),
      reason: overrideReason.trim() || undefined,
    })
    setSaving(false)

    if (res.ok && res.person) {
      toast.push({
        tone: 'success',
        title: 'Member record created',
        message: `${fullName(res.person)} · ${res.person.reference_no}${res.matches?.length ? ` · ${res.matches.length} possible match(es) queued for review` : ''}`,
      })
      navigate(`/members/${res.person.id}`)
      return
    }

    if (res.code === 'DUPLICATE_REVIEW_REQUIRED') {
      setVerdict({
        band: (res.band as MatchBand) ?? 'VERY_LIKELY',
        score: res.matches?.[0]?.score.score ?? 100,
        matches: res.matches ?? [],
        code: res.code,
        message: res.error,
      })
      setReviewedExisting(true)
      return
    }
    setError(res.error ?? 'The record could not be saved.')
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Members', to: '/members' }, { label: 'Add member' }]}
        title="Add Member"
        subtitle="Nothing is created until the registry has been checked for an existing person."
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <IconArrowLeft /> Back
          </Button>
        }
      />

      {/* step indicator */}
      <ol className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        {[
          { n: 1, label: 'Search existing members' },
          { n: 2, label: 'Enter details & check duplicates' },
          { n: 3, label: 'Confirm and save' },
        ].map((s) => (
          <li key={s.n} className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold',
                step === s.n ? 'bg-gov-900 text-white' : step > s.n ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600',
              )}
            >
              {step > s.n ? '✓' : s.n}
            </span>
            <span className={cn('font-medium', step === s.n ? 'text-ink' : 'text-ink-soft')}>{s.label}</span>
            {s.n < 3 && <IconArrowRight className="h-3 w-3 text-slate-300" />}
          </li>
        ))}
      </ol>

      {/* ---------------------------------------------------------- STEP 1 */}
      {step === 1 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="card-header">
              <div>
                <h2 className="section-title">Search existing members</h2>
                <p className="mt-0.5 text-xs text-ink-soft">
                  Before creating a new member, search the municipal registry to prevent duplicate records.
                </p>
              </div>
            </div>
            <div className="card-pad space-y-3">
              <div className="relative">
                <IconSearch className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-slate-400" />
                <input
                  autoFocus
                  className="input pl-9 text-base"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, birthdate, contact number or reference number"
                  aria-label="Search the municipal registry"
                />
                {searching && <IconSpinner className="absolute top-3 right-3 text-gov-700" />}
              </div>

              {query.trim().length >= 2 && (
                <div className="rounded-md border border-line">
                  <p className="border-b border-line bg-slate-50 px-3 py-2 text-[11px] font-semibold text-ink-soft uppercase">
                    {searching ? 'Searching…' : `Possible existing records (${results.length})`}
                  </p>
                  {!searching && results.length === 0 && (
                    <p className="px-3 py-6 text-center text-xs text-ink-soft">
                      No member matches “{query}”. Continue to enter the new record.
                    </p>
                  )}
                  <ul className="divide-y divide-line">
                    {results.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-ink">
                            {fullName(p)} {p.suffix ?? ''}
                          </p>
                          <p className="text-[11px] text-ink-soft">
                            Barangay: <span className="font-medium text-ink">{p.barangay_name ?? '—'}</span> · Born{' '}
                            {formatDate(p.date_of_birth)} · {maskContact(p.contact_number)} · {p.reference_no}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={p.status} />
                          <Button size="sm" variant="secondary" onClick={() => navigate(`/members/${p.id}`)}>
                            <IconEye /> View record
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => useExisting(p.id, fullName(p), p.barangay_name)}
                          >
                            <IconCheck /> This is the same person
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {query.trim().length < 2 && (
                <p className="rounded-md border border-dashed border-line bg-slate-50 px-3 py-6 text-center text-xs text-ink-soft">
                  Type at least two characters. Search matches partial names, birthdates, contact numbers, purok and
                  reference numbers.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
              <p className="text-[11px] text-ink-soft">
                Not in the registry? Continue — the next step checks again automatically while you type.
              </p>
              <Button variant="primary" onClick={() => setStep(2)}>
                <IconPlus /> This is a new member
              </Button>
            </div>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title">Why this step exists</h2>
            <ul className="mt-3 space-y-2 text-xs text-ink-soft">
              <li>Multiple administrators encode members from different barangays and cannot see each other's work.</li>
              <li>The registry is central: one person, one master record, with barangay history.</li>
              <li>Every save is re-checked in PostgreSQL, and simultaneous submissions are refused by a unique identity index.</li>
            </ul>
            <div className="mt-3 rounded-md border border-gov-200 bg-gov-50 p-3 text-[11px] text-gov-900">
              <p className="font-semibold">Match bands</p>
              <ul className="mt-1 space-y-1">
                {(['VERY_LIKELY', 'POSSIBLE', 'POTENTIAL'] as MatchBand[]).map((b) => (
                  <li key={b}>
                    <span className="font-semibold">{BAND_META[b].label}</span> — {BAND_META[b].description}
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        </div>
      )}

      {/* ---------------------------------------------------------- STEP 2 */}
      {step === 2 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="card-header">
              <h2 className="section-title">Member details</h2>
              <Button size="sm" variant="ghost" onClick={() => setStep(1)}>
                <IconSearch /> Search again
              </Button>
            </div>
            <div className="card-pad space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="First name" required>
                  <input className="input" value={form.first_name} onChange={(e) => update({ first_name: e.target.value })} autoFocus />
                </Field>
                <Field label="Middle name" hint="Leave blank when the record genuinely has none.">
                  <input className="input" value={form.middle_name} onChange={(e) => update({ middle_name: e.target.value })} />
                </Field>
                <Field label="Last name" required>
                  <input className="input" value={form.last_name} onChange={(e) => update({ last_name: e.target.value })} />
                </Field>
                <Field label="Suffix" hint="Jr., Sr., III">
                  <input className="input" value={form.suffix} onChange={(e) => update({ suffix: e.target.value })} />
                </Field>
                <Field label="Date of birth" hint="MM/DD/YYYY or YYYY-MM-DD">
                  <input className="input" value={form.date_of_birth} onChange={(e) => update({ date_of_birth: e.target.value })} placeholder="01/12/1985" />
                </Field>
                <Field label="Sex">
                  <select className="input" value={form.sex} onChange={(e) => update({ sex: e.target.value as FormState['sex'] })}>
                    <option value="">Not recorded</option>
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                  </select>
                </Field>
                <Field label="Civil status">
                  <select className="input" value={form.civil_status} onChange={(e) => update({ civil_status: e.target.value })}>
                    <option value="">Not recorded</option>
                    {CIVIL.map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
                  </select>
                </Field>
                <Field label="Barangay" required>
                  <select className="input" value={form.barangay_id} onChange={(e) => update({ barangay_id: e.target.value })}>
                    <option value="">Select barangay…</option>
                    {barangays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <Field label="Purok / Sitio">
                  <input className="input" value={form.purok} onChange={(e) => update({ purok: e.target.value })} placeholder="Purok 3" />
                </Field>
                <Field label="Contact number" hint="Used as an extra matching signal.">
                  <input className="input" value={form.contact_number} onChange={(e) => update({ contact_number: e.target.value })} placeholder="09171234567" />
                </Field>
                <Field label="Complete address" className="sm:col-span-2">
                  <input className="input" value={form.address} onChange={(e) => update({ address: e.target.value })} placeholder="Purok 3, San Isidro, Nabua, Camarines Sur" />
                </Field>
                <Field label="Remarks" className="sm:col-span-2">
                  <textarea className="input" rows={2} value={form.remarks} onChange={(e) => update({ remarks: e.target.value })} />
                </Field>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
              <Button variant="ghost" onClick={() => setStep(1)}><IconArrowLeft /> Back to search</Button>
              <Button
                variant="primary"
                disabled={saveDisabled}
                loading={saving}
                onClick={() => void submit()}
              >
                <IconCheck /> Save member record
              </Button>
            </div>
            {saveDisabled && !saving && (
              <p className="border-t border-line bg-slate-50 px-4 py-2 text-[11px] text-ink-soft">
                {checking
                  ? 'Saving is disabled while the duplicate check runs…'
                  : !form.first_name.trim() || !form.last_name.trim()
                    ? 'Enter at least a first and last name.'
                    : !checkedOnce
                      ? 'Waiting for the duplicate check to finish…'
                      : needsAcknowledgement && !reviewedExisting
                        ? 'A similar record was found. Confirm that you reviewed the possible match before saving.'
                        : blocking && !overrideReason.trim()
                          ? 'A likely duplicate was found. Record the reason this is a different resident before saving.'
                          : ''}
              </p>
            )}
          </Card>

          <div className="space-y-3">
            <Card className="card-pad">
              <h2 className="section-title">Duplicate check</h2>
              <div className="mt-3">
                <LiveDuplicateIndicator
                  state={checking ? 'checking' : checkedOnce ? 'done' : 'idle'}
                  band={band}
                  count={matches.length}
                  hasInput={hasInput}
                />
              </div>
              {matches.length > 0 && (
                <div className="mt-3 space-y-3 max-h-[28rem] overflow-y-auto pr-1">
                  {matches.slice(0, 5).map((m, i) => (
                    <MatchCard
                      key={`${m.person.id}-${i}`}
                      match={m}
                      onViewRecord={() => navigate(`/members/${m.person.id}`)}
                      onUseExisting={(mm) => useExisting(mm.person.id, fullName(mm.person), mm.person.barangay_name)}
                      onMarkDifferent={() => setReviewedExisting(true)}
                    />
                  ))}
                </div>
              )}
              {checkedOnce && matches.length === 0 && hasInput && (
                <p className="mt-3 text-[11px] text-ink-soft">
                  The registry was checked against name, birthdate, sex, barangay, purok, address and contact number.
                  Nothing similar was found.
                </p>
              )}
            </Card>

            {(veryLikely || requiresConfirmation) && (
              <Card className="card-pad border-amber-300 bg-amber-50/50">
                <h2 className="section-title">Confirmation required</h2>
                <p className="mt-2 text-xs text-ink-soft">
                  {veryLikely
                    ? 'A likely duplicate exists. Either open the existing record and continue from it, or state why these are two different residents. Both paths are audited and the pair is queued for supervisor review.'
                    : 'A similar member exists. Tick the box below to confirm you reviewed the possible match before saving.'}
                </p>
                <label className="mt-3 flex items-start gap-2 text-xs font-medium text-ink">
                  <input type="checkbox" className="mt-0.5" checked={reviewedExisting}
                    onChange={(e) => setReviewedExisting(e.target.checked)} />
                  {veryLikely
                    ? 'I reviewed the possible match above and this is a genuinely different resident.'
                    : 'I reviewed the similar record above and this is a different person.'}
                </label>
                <Field label="Reason (required for a likely duplicate)" className="mt-3">
                  <textarea
                    className="input"
                    rows={2}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="e.g. Verified as a different person: father and son share the same name."
                  />
                </Field>
                {blocking && !overrideReason.trim() && (
                  <p className="mt-1 text-[11px] font-semibold text-red-700">
                    Saving stays blocked until a reason is recorded.
                  </p>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- use existing person */}
      <Modal
        open={!!samePerson}
        onClose={() => setSamePerson(null)}
        title="Existing Member Found"
        description="Is this the same person?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSamePerson(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (samePerson) navigate(`/members/${samePerson.id}?mode=existing`)
              }}
            >
              <IconEye /> Open existing record
            </Button>
          </>
        }
      >
        {samePerson && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-line bg-slate-50 p-3">
              <p className="text-base font-bold text-ink">{samePerson.name}</p>
              <p className="text-xs text-ink-soft">Current barangay: {samePerson.barangay ?? '—'}</p>
            </div>
            <p className="text-xs text-ink-soft">
              Choosing the existing record does <span className="font-semibold text-ink">not</span> create a second person.
              From the member profile you can update details, transfer the barangay (history is preserved) or add
              household information.
            </p>
          </div>
        )}
      </Modal>

      {/* ---------------------------------------------------------- blocked verdict */}
      <Modal
        open={!!verdict}
        onClose={() => setVerdict(null)}
        title="🔴 Duplicate likely — record not created"
        description={verdict?.message}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setVerdict(null)}>Back to the form</Button>
            {verdict?.matches?.[0] && (
              <Button variant="primary" onClick={() => navigate(`/members/${verdict.matches[0].person.id}`)}>
                <IconEye /> Open existing record
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-ink-soft">
            An existing member with highly similar information was found. Review the record before continuing — one
            person must have one master record.
          </p>
          {verdict?.matches.map((m, i) => (
            <MatchCard key={`${m.person.id}-${i}`} match={m} actions={false} />
          ))}
        </div>
      </Modal>

      {error && (
        <Modal open={!!error} onClose={() => setError(null)} title="Could not save the record"
          footer={<Button variant="secondary" onClick={() => setError(null)}>Close</Button>}>
          <p className="flex items-start gap-2 text-sm text-red-800"><IconAlert className="mt-0.5" /> {error}</p>
        </Modal>
      )}

      {step === 3 && <div className="hidden">Review step</div>}
    </>
  )
}
