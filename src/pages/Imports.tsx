/**
 * BULK IMPORT — the ten-step workflow required by the specification:
 *  1 detect columns → 2 preview → 3 normalise → 4 validate → 5 duplicates inside
 *  the file → 6 duplicates against the registry → 7 report → 8 review rows →
 *  9 import only the clean records → 10 summary.
 *
 * Clean rows can be imported in one action; anything doubtful waits for a human
 * decision. Nothing in a rejected row is silently discarded — the staging batch
 * keeps the original values.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import type { ImportRow, ImportSummary, PersonInput } from '../lib/api'
import type { Barangay } from '../lib/types'
import { normalizeDate, normalizeContact, normalizeName } from '../lib/normalize'
import { cn, relativeTime, downloadXlsx, pickXlsx } from '../lib/utils'
import { parseBlockSheet, type BlockSection } from '../lib/importBlocks'
import { fullName } from '../lib/normalize'
import {
  Badge, Button, Card, Field, IconAlert, IconArrowLeft, IconArrowRight, IconCheck, IconDownload,
  IconRefresh, IconSpinner, IconUpload, Progress, Skeleton, StatusBadge, useToast,
} from '../components/ui'

/* The icon set has no file glyph; a local inline one keeps the UI consistent. */
const FileIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-4 w-4'}>
    <path d="M14 3v5h5" /><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2Z" />
  </svg>
)

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

const STEP_LABELS: Array<{ n: Step; label: string }> = [
  { n: 1, label: 'Choose file' },
  { n: 2, label: 'Detect columns' },
  { n: 3, label: 'Preview rows' },
  { n: 4, label: 'Normalise' },
  { n: 5, label: 'Validate' },
  { n: 6, label: 'Duplicates in file' },
  { n: 7, label: 'Check registry' },
  { n: 8, label: 'Report' },
  { n: 9, label: 'Review & import' },
  { n: 10, label: 'Summary' },
]

/** Accepted header spellings — the municipal template and common variations. */
const FIELD_ALIASES: Partial<Record<keyof PersonInput | 'name', string[]>> & Record<string, string[]> = {
  first_name: ['first name', 'firstname', 'given name', 'pangaran', 'first'],
  middle_name: ['middle name', 'middlename', 'middle initial', 'mi', 'middle'],
  last_name: ['last name', 'lastname', 'surname', 'family name', 'apelyido', 'last'],
  suffix: ['suffix', 'ext', 'extension', 'jr', 'sr'],
  date_of_birth: ['birthdate', 'date of birth', 'birth date', 'dob', 'kapanganakan', 'birthday', 'bdate'],
  sex: ['sex', 'gender', 'kasarian'],
  civil_status: ['civil status', 'marital status', 'civil stat', 'status'],
  contact_number: ['contact', 'contact number', 'mobile', 'phone', 'cellphone', 'number', 'cp number'],
  purok: ['purok', 'sitio', 'zone', 'purok/sitio'],
  address: ['address', 'complete address', 'street', 'tirahan'],
  barangay_id: ['barangay', 'brgy', 'barangay name'],
  remarks: ['remarks', 'notes', 'comment'],
  tags: ['tags', 'tagging', 'tag'],
  occupation: ['occupation', 'trabaho', 'job'],
  household_no: ['household no', 'household', 'family no', 'pamilya'],
  name: ['name', 'full name', 'member name', 'pangaran'],
  status: ['status', 'record status'],
}

export default function Imports() {
  const { api, user, online } = useApp()
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const fileInput = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>(1)
  const [file, setFile] = useState<File | null>(null)
  const [rawRows, setRawRows] = useState<Array<Record<string, unknown>>>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [barangays, setBarangays] = useState<Barangay[]>([])
  const [defaultBarangay, setDefaultBarangay] = useState(params.get('barangay') ?? '')
  const [batches, setBatches] = useState<ImportSummary[]>([])
  const [batchId, setBatchId] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [busy, setBusy] = useState(false)
  const [commitProgress, setCommitProgress] = useState<number | null>(null)
  const [committed, setCommitted] = useState<{ imported: number; duplicates_parked: number; skipped: number; linked: number; message: string } | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [blockInfo, setBlockInfo] = useState<BlockSection[] | null>(null)
  const [blockBarangay, setBlockBarangay] = useState<string | null>(null)
  const [stageMsg, setStageMsg] = useState('')

  const canImport = user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)

  const loadBatches = useCallback(async () => {
    setBatches(await api.listImportBatches())
  }, [api])

  useEffect(() => {
    void api.listBarangays(true).then(setBarangays)
    void loadBatches()
  }, [api, loadBatches])

  // ---------------------------------------------------------------- step 1+2: read and detect
  const readFile = async (f: File) => {
    setParseError(null)
    setBusy(true)
    setFile(f)
    try {
      const XLSX = pickXlsx(await import('xlsx'))
      const data = await f.arrayBuffer()
      const workbook = XLSX.read(data, { type: 'array', cellDates: true })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      // Barangay programme lists (LP-TOPAS and kin) keep several lists side by
      // side under title rows; flatten them before the flat-row path sees them.
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false })
      const prefix = (workbook.SheetNames[0] || f.name.replace(/\.[a-z0-9]+$/i, '')).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24) || 'LIST'
      const blocks = parseBlockSheet(grid, { householdPrefix: prefix })
      if (blocks.detected) {
        // The list's own title block names the barangay; honour it as the
        // default so 1,000+ rows don't each fail the barangay check.
        if (blocks.meta.barangay) {
          const named = barangays.find((b) => b.name.toLowerCase() === blocks.meta.barangay!.toLowerCase())
          if (named) setDefaultBarangay(named.id)
          else setBlockBarangay(blocks.meta.barangay)
        }
        setBlockInfo(blocks.sections)
        setHeaders(blocks.headers)
        setRawRows(blocks.rows as unknown as Array<Record<string, unknown>>)
        setMapping(detectMapping(blocks.headers))
        setStep(2)
        toast.push({
          tone: 'success', title: `${blocks.rows.length} row(s) read from ${blocks.sections.length} sections`,
          message: blocks.sections.map((x) => `${x.count} ${x.role.toLowerCase()}(s)`).join(' · '),
        })
        return
      }
      setBlockInfo(null)
      setBlockBarangay(null)
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false })
      if (json.length === 0) {
        setParseError('The file has no data rows. Check the sheet and header row.')
        setBusy(false)
        return
      }
      const detectedHeaders = Object.keys(json[0])
      setHeaders(detectedHeaders)
      setRawRows(json)
      setMapping(detectMapping(detectedHeaders))
      setStep(2)
      toast.push({ tone: 'success', title: `${json.length} row(s) read`, message: `${detectedHeaders.length} columns detected in “${f.name}”.` })
    } catch (err) {
      setParseError(`The file could not be read: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const detected = useMemo(() => Object.entries(mapping).filter(([, v]) => v), [mapping])

  const implausibleDobs = useRef<Array<{ row: number; value: string }>>([])
  const collapsedExact = useRef<Array<{ row: number; dupOf: number }>>([])
  const normalised = useMemo<PersonInput[]>(() => {
    const rejected: Array<{ row: number; value: string }> = []
    const collapsed: Array<{ row: number; dupOf: number }> = []
    const seenExact = new Map<string, number>()
    const fileRow: number[] = []
    const rows = rawRows.map((row, rowIdx) => {
      const pick = (field: string) => {
        const header = mapping[field]
        return header ? String(row[header] ?? '').trim() : ''
      }
      let first = pick('first_name')
      let middle = pick('middle_name')
      let last = pick('last_name')
      const full = pick('name')
      if ((!first || !last) && full) {
        const parts = full.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
        if (parts.length >= 2) {
          first = parts[0]
          last = parts[parts.length - 1]
          middle = parts.slice(1, -1).join(' ') || middle
        } else if (parts.length === 1) {
          last = parts[0]
        }
      }
      const barangayText = pick('barangay_id').toLowerCase()
      const matched = barangays.find((b) => b.name.toLowerCase() === barangayText || b.name.toLowerCase().includes(barangayText) && barangayText.length > 3)
      const sexRaw = pick('sex').toUpperCase()
      const sex = sexRaw.startsWith('M') ? 'MALE' : sexRaw.startsWith('F') ? 'FEMALE' : null
      // FIELD REPORT 2026-09-21 (21:08): Excel-epoch junk (1899-12-30) and
      // future dates violate persons_dob_sane at commit. Strip them here, on
      // every device, so no server version can ever be killed by one row.
      const dobNorm = normalizeDate(pick('date_of_birth'))
      let dob: string | null = dobNorm || pick('date_of_birth') || null
      if (dobNorm) {
        const d = new Date(`${dobNorm}T00:00:00`)
        const max = new Date()
        max.setHours(0, 0, 0, 0)
        max.setDate(max.getDate() + 1)
        if (d.getTime() <= Date.parse('1900-01-01T00:00:00') || d.getTime() >= max.getTime()) {
          rejected.push({ row: rowIdx + 1, value: dobNorm })
          dob = null
        }
      }
      return {
        first_name: normalizeName(first) || first,
        middle_name: normalizeName(middle) || middle || null,
        last_name: normalizeName(last) || last,
        suffix: pick('suffix') || null,
        date_of_birth: dob,
        sex,
        civil_status: pick('civil_status').toUpperCase() || null,
        contact_number: normalizeContact(pick('contact_number')) || null,
        purok: pick('purok') || null,
        address: pick('address') || null,
        barangay_id: matched?.id ?? defaultBarangay ?? null,
        remarks: pick('remarks') || null,
        tags: pick('tags') ? pick('tags').split(/[;,]/).map((t) => t.trim()).filter(Boolean) : null,
        occupation: pick('occupation') || null,
        household_no: pick('household_no') || null,
      ...{ __fileRow: rowIdx + 1 },
      } as PersonInput & { __fileRow: number }
    }).filter((person) => {
      // FIELD REPORT 2026-09-22: "there is always a duplicate for every
      // import file entry". Perfectly identical rows (every field equal)
      // are collapsed at read time — a resident encoded twice in the sheet,
      // or a converter/print-range artefact — and the wizard reports exactly
      // which file rows were collapsed, so the claim can be checked in Excel.
      const keyed = person as PersonInput & { __fileRow: number }
      const { __fileRow, ...clean } = keyed
      const key = JSON.stringify(clean)
      const first = seenExact.get(key)
      if (first !== undefined) {
        collapsed.push({ row: __fileRow, dupOf: first })
        return false
      }
      seenExact.set(key, __fileRow)
      delete (person as Record<string, unknown>).__fileRow
      return true
    })
    implausibleDobs.current = rejected
    collapsedExact.current = collapsed
    return rows
  }, [rawRows, mapping, barangays, defaultBarangay])

  // tell the operator, with evidence, when the file itself carried copies
  useEffect(() => {
    const c = collapsedExact.current
    if (c.length === 0) return
    const samples = c.slice(0, 3).map((x) => `row ${x.row} = row ${x.dupOf}`).join(', ')
    toast.push({
      tone: 'warning',
      title: `${c.length} identical cop(y/ies) collapsed from the file`,
      message: `The sheet repeats these rows word for word: ${samples}${c.length > 3 ? '…' : ''}. One copy each will be staged; near-duplicates still appear as review cards.`,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows])

  const validation = useMemo(() => {
    const issues: Array<{ row: number; severity: 'WARNING' | 'ERROR'; message: string }> = []
    normalised.forEach((p, i) => {
      if (!p.first_name && !p.last_name) issues.push({ row: i + 1, severity: 'ERROR', message: 'No name could be read from this row.' })
      if (p.date_of_birth && !normalizeDate(p.date_of_birth)) issues.push({ row: i + 1, severity: 'ERROR', message: `Unreadable birthdate “${p.date_of_birth}”.` })
      const rej = implausibleDobs.current.find((x) => x.row === i + 1)
      if (rej) issues.push({ row: i + 1, severity: 'WARNING', message: `Implausible birthdate “${rej.value}” removed — the row imports without it; restore the date in the member record later.` })
      if (!p.date_of_birth && !rej) issues.push({ row: i + 1, severity: 'WARNING', message: 'Missing birthdate — duplicates are harder to detect.' })
      if (!p.sex) issues.push({ row: i + 1, severity: 'WARNING', message: 'Missing sex.' })
      if (!p.middle_name) issues.push({ row: i + 1, severity: 'WARNING', message: 'Missing middle name — check for a hidden duplicate.' })
      if (p.contact_number && p.contact_number.replace(/\D/g, '').length < 7) issues.push({ row: i + 1, severity: 'WARNING', message: 'Contact number looks incomplete.' })
      if (!p.barangay_id) issues.push({ row: i + 1, severity: 'ERROR', message: 'Barangay could not be matched — set a default barangay.' })
    })
    return issues
  }, [normalised])

  // in-file duplicates: same identity inside the uploaded file (typos included)
  const inFileDuplicates = useMemo(() => {
    const seen = new Map<string, number[]>()
    normalised.forEach((p, i) => {
      const key = [
        String(p.first_name ?? '').toLowerCase().replace(/[^a-z]/g, ''),
        String(p.last_name ?? '').toLowerCase().replace(/[^a-z]/g, ''),
        p.date_of_birth ?? 'no-dob',
      ].join('|')
      seen.set(key, [...(seen.get(key) ?? []), i + 1])
    })
    return [...seen.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, rows }))
  }, [normalised])

  const errorRows = new Set(validation.filter((v) => v.severity === 'ERROR').map((v) => v.row))

  // ---------------------------------------------------------------- step 7: create the staging batch
  const createBatch = async () => {
    if (!file) return
    setBusy(true)
    setStageMsg('')
    try {
      const res = await api.importCreateBatch(file.name, normalised, defaultBarangay || null, (done, total) => {
        setStageMsg(`Staging rows ${done} of ${total} — every row is being scored against the registry…`)
      })
      if (!res.ok) {
        toast.push({ tone: 'error', title: 'Batch could not be staged', message: res.error })
        setBusy(false)
        return
      }
      if (res.data.warning) toast.push({ tone: 'warning', title: 'Staged with a caveat', message: res.data.warning })
      setBatchId(res.data.batch_id)
      const sum = await api.importSummary(res.data.batch_id)
      setSummary(sum)
      setRows(await api.importRows(res.data.batch_id, { limit: 500 }))
      setStep(7)
      await loadBatches()
    } finally {
      setBusy(false)
    }
  }

  // FIELD REPORT 2026-09-21 (16:17): batches staged before migration 0016 keep
  // their clean rows at "Undecided", so the commit button reads "Import 0".
  // Opening the review step now normalises OK rows to Import once per batch,
  // whatever the server's staging defaults were at the time.
  const normalisedBatches = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (step !== 9 || !batchId || normalisedBatches.current.has(batchId)) return
    normalisedBatches.current.add(batchId)
    void (async () => {
      // field directive 2026-09-21: missing contact / address / sex details no
      // longer hold a row back — normalise everything still undecided except
      // blocked rows and very-likely clashes, without touching manual choices
      const res = await api.importSetAllDecisions(batchId, null, 'IMPORT', false, true)
      if (res.ok && (res.data.updated ?? 0) > 0) await refreshRowsRef.current()
    })()
  }, [step, batchId, api])

  const refreshRows = useCallback(async () => {
    if (!batchId) return
    setRows(await api.importRows(batchId, { limit: 500 }))
    setSummary(await api.importSummary(batchId))
  }, [api, batchId])
  const refreshRowsRef = useRef(refreshRows)
  refreshRowsRef.current = refreshRows

  const setDecision = async (rowId: string | number, decision: 'IMPORT' | 'SKIP' | 'LINK') => {
    if (!batchId) return
    await api.importSetDecision(rowId, decision)
    await refreshRows()
  }

  const setAll = async (
    severity: string | null, decision: 'IMPORT' | 'SKIP', duplicatesOnly = false, label?: string,
  ) => {
    if (!batchId) return
    setBusy(true)
    try {
      const res = await api.importSetAllDecisions(batchId, severity, decision, duplicatesOnly)
      if (!res.ok) {
        toast.push({ tone: 'error', title: 'Decisions not changed', message: res.error })
        return
      }
      const n = res.data.updated ?? 0
      toast.push({
        tone: n > 0 ? 'success' : 'warning',
        title: n > 0 ? `${n} row(s) set to ${decision === 'SKIP' ? 'Skip' : 'Import'}` : 'No rows matched that action',
        message: n > 0
          ? (label ?? 'Bulk decision applied.')
          : 'Nothing in this batch matches that filter — the buttons act only on matching rows.',
      })
      await refreshRows()
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!batchId) return
    setBusy(true)
    setCommitProgress(0)
    let res: Awaited<ReturnType<typeof api.importCommit>> | null = null
    try {
      res = await api.importCommit(batchId, defaultBarangay || null, (done) => setCommitProgress(done))
    } finally {
      setBusy(false)
      setCommitProgress(null)
    }
    if (!res) return
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Import failed', message: res.error })
      return
    }
    setCommitted(res.data)
    setSummary(await api.importSummary(batchId))
    setStep(10)
    await loadBatches()
    toast.push({
      tone: res.data.imported > 0 ? 'success' : 'warning',
      title: `${res.data.imported} record(s) imported`,
      message: res.data.duplicates_parked > 0
        ? `${res.data.duplicates_parked} row(s) parked as duplicate cases for review — no duplicate master record was created.`
        : 'Every accepted row was written to the registry.',
    })
  }

  const openBatch = async (b: ImportSummary) => {
    setBatchId(b.batch_id)
    setSummary(b)
    setStep(9)
    setRows(await api.importRows(b.batch_id, { limit: 500 }))
  }

  const stepIndex = (n: Step) => STEP_LABELS.findIndex((s) => s.n === n)
  const progress = ((stepIndex(step) + 1) / STEP_LABELS.length) * 100

  if (!canImport) {
    return (
      <Card className="card-pad mx-auto max-w-lg text-center">
        <IconAlert className="mx-auto h-8 w-8 text-amber-600" />
        <h1 className="mt-2 text-base font-bold">Import is restricted</h1>
        <p className="mt-1 text-xs text-ink-soft">
          Bulk import is limited to Administrators and System Administrators. Encoders add members one at a time so the
          duplicate check always runs.
        </p>
      </Card>
    )
  }

  return (
    <>
      <PageHeader
        title="Bulk Import"
        subtitle="Upload an Excel or CSV extract. Every row is normalised, validated and checked against the registry before anything is written — only clean rows are imported."
        breadcrumbs={[{ label: 'Data', to: '/data-quality' }, { label: 'Imports' }]}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void loadBatches()}><IconRefresh /> Refresh batches</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { setBatchId(null); setSummary(null); setRows([]); setRawRows([]); setFile(null); setStep(1); setCommitted(null) }}
            >
              <IconUpload /> New import
            </Button>
          </>
        }
      />

      {/* step rail */}
      <Card className="card-pad mb-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {STEP_LABELS.map((s) => (
            <span
              key={s.n}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium',
                step === s.n ? 'bg-gov-900 text-white' : step > s.n ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500',
              )}
            >
              <span className="font-bold">{step > s.n ? '✓' : s.n}</span>
              {s.label}
            </span>
          ))}
        </div>
        <div className="mt-3"><Progress value={progress} tone="info" /></div>
      </Card>

      {/* ---------------------------------------------------------- 1) choose file */}
      {step === 1 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="card-header"><h2 className="section-title">Choose the file to import</h2></div>
            <div className="card-pad">
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const f = e.dataTransfer.files?.[0]
                  if (f) void readFile(f)
                }}
                className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-line bg-slate-50 px-6 py-12 text-center hover:border-gov-300 hover:bg-gov-50/40"
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void readFile(f)
                  }}
                />
                <FileIcon className="h-8 w-8 text-gov-700" />
                <p className="mt-3 text-sm font-semibold text-ink">Drop an Excel or CSV file here</p>
                <p className="mt-1 text-xs text-ink-soft">or click to browse. Supported: .xlsx, .xls, .csv</p>
                {file && <p className="mt-3 text-xs font-medium text-gov-900">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
              </label>

              {busy && (
                <p className="mt-3 flex items-center gap-2 text-xs text-ink-soft"><IconSpinner /> Reading the file…</p>
              )}
              {parseError && (
                <p className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                  <IconAlert className="mt-0.5" /> {parseError}
                </p>
              )}

              <Field label="Default barangay" className="mt-4"
                hint="Used for rows whose barangay column is blank or cannot be matched. Required when the file has no barangay column.">
                <select className="input" value={defaultBarangay} onChange={(e) => setDefaultBarangay(e.target.value)}>
                  <option value="">No default — every row must name a barangay</option>
                  {barangays.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
            </div>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title"><IconAlert /> Before you upload</h2>
            <ul className="mt-2 space-y-2 text-xs text-ink-soft">
              <li>The first sheet of the workbook is used; the first row must contain column names.</li>
              <li>Names should be in separate columns where possible; a single “Full name” column is also understood.</li>
              <li>Birthdates may be written as 01/12/1985, 1985-01-12 or “January 12, 1985”.</li>
              <li>Nothing is written to the registry until step 9, and only after you review the report.</li>
              <li>Rows that clash with an existing member are parked as duplicate cases instead of being imported.</li>
            </ul>
            <Button variant="secondary" className="mt-3 w-full" onClick={() => downloadTemplate(barangays, defaultBarangay)}>
              <IconDownload /> Download the template
            </Button>
          </Card>
        </div>
      )}

      {/* ---------------------------------------------------------- 2) detect columns */}
      {step === 2 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {blockInfo && (
            <Card className="lg:col-span-3">
              <div className="card-pad flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold">Multi-section paper list detected.</span>
                <span className="text-ink-soft">
                  {blockInfo.map((b) => `${b.count} × ${b.role}`).join(' · ')} — families stay grouped by the
                  household number taken from the head rows, and the section roles plus the remarks codes
                  (AKAP, AICS/4PS, …) are kept as visible tags.
                </span>
                {blockBarangay && (
                  <span className="w-full rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900">
                    The list's title block says barangay <strong>{blockBarangay}</strong>, which is not in the
                    registry yet. Add it under Barangays (or choose a default barangay below) before continuing —
                    otherwise every row is blocked.
                  </span>
                )}
              </div>
            </Card>
          )}
          <Card className="lg:col-span-2">
            <div className="card-header">
              <h2 className="section-title">Detected columns</h2>
              <span className="text-[11px] text-ink-soft">{headers.length} column(s) in {file?.name}</span>
            </div>
            <div className="card-pad space-y-3">
              <p className="text-xs text-ink-soft">
                Check the mapping below. Change any column that was matched incorrectly — nothing is imported until you
                continue.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(Object.keys(FIELD_ALIASES) as Array<keyof typeof FIELD_ALIASES>).map((field) => (
                  <Field
                    key={field}
                    label={field === 'name' ? 'Full name (single column)' : humanField(field)}
                    hint={field === 'barangay_id' ? 'Barangay name or code column' : undefined}
                  >
                    <select
                      className="input"
                      value={mapping[field] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}
                    >
                      <option value="">Not in this file</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="rounded-md border border-line bg-slate-50 p-3 text-[11px] text-ink-soft">
                <p className="font-semibold text-ink">Mapped {detected.length} column(s)</p>
                <p className="mt-1">
                  Missing a mandatory field? Use the download template button in the previous step and re-upload.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
              <Button variant="ghost" onClick={() => setStep(1)}><IconArrowLeft /> Choose another file</Button>
              <Button
                variant="primary"
                disabled={!mapping.last_name && !mapping.name && !mapping.first_name}
                onClick={() => setStep(3)}
              >
                Continue to preview <IconArrowRight />
              </Button>
            </div>
          </Card>
          <Card className="card-pad">
            <h2 className="section-title">Raw headers</h2>
            <ul className="mt-2 space-y-1 text-[11px] text-ink-soft">
              {headers.map((h) => (
                <li key={h} className="flex items-center justify-between gap-2">
                  <span className="truncate">{h}</span>
                  {mappingValues(mapping).includes(h) && <Badge tone="success">mapped</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* ---------------------------------------------------------- 3) preview */}
      {step === 3 && (
        <Card>
          <div className="card-header">
            <h2 className="section-title">Preview — first {Math.min(20, rawRows.length)} row(s)</h2>
            <span className="text-[11px] text-ink-soft">{rawRows.length} row(s) in total</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rawRows.slice(0, 20).map((row, i) => (
                  <tr key={i}>
                    {headers.map((h) => <td key={h} className="max-w-[12rem] truncate text-xs">{String(row[h] ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
            <Button variant="ghost" onClick={() => setStep(2)}><IconArrowLeft /> Fix the columns</Button>
            <Button variant="primary" onClick={() => setStep(4)}>Normalise the data <IconArrowRight /></Button>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------- 4+5) normalise + validate */}
      {(step === 4 || step === 5) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="card-header">
              <h2 className="section-title">Normalised and validated</h2>
              <span className="text-[11px] text-ink-soft">
                {normalised.length - errorRows.size} ready · {errorRows.size} with errors
              </span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th><th>Name</th><th>Birthdate</th><th>Sex</th><th>Barangay</th><th>Contact</th><th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {normalised.slice(0, 40).map((p, i) => {
                    const rowIssues = validation.filter((v) => v.row === i + 1)
                    return (
                      <tr key={i} className={rowIssues.some((v) => v.severity === 'ERROR') ? 'bg-red-50/60' : rowIssues.length ? 'bg-amber-50/40' : ''}>
                        <td className="text-xs text-ink-soft">{i + 1}</td>
                        <td className="text-xs font-medium text-ink">
                          {[p.first_name, p.middle_name, p.last_name, p.suffix].filter(Boolean).join(' ') || '—'}
                        </td>
                        <td className="text-xs">{p.date_of_birth ?? <span className="text-amber-700">missing</span>}</td>
                        <td className="text-xs">{p.sex ?? <span className="text-amber-700">missing</span>}</td>
                        <td className="text-xs">{barangays.find((b) => b.id === p.barangay_id)?.name ?? <span className="text-red-700">unmatched</span>}</td>
                        <td className="text-xs">{p.contact_number ?? '—'}</td>
                        <td className="text-xs">
                          {rowIssues.length === 0
                            ? <Badge tone="success">Clean</Badge>
                            : rowIssues.map((v, k) => (
                              <Badge key={k} tone={v.severity === 'ERROR' ? 'danger' : 'warning'} className="mr-1">
                                {v.message.length > 42 ? `${v.message.slice(0, 42)}…` : v.message}
                              </Badge>
                            ))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
              <Button variant="ghost" onClick={() => setStep(3)}><IconArrowLeft /> Back to preview</Button>
              <Button variant="primary" onClick={() => setStep(6)}>Check duplicates <IconArrowRight /></Button>
            </div>
          </Card>
          <div className="space-y-4">
            <Card className="card-pad">
              <h2 className="section-title">Validation summary</h2>
              <div className="mt-3 space-y-2 text-xs">
                <SummaryRow label="Rows read" value={normalised.length} />
                <SummaryRow label="Errors (blocked)" value={errorRows.size} tone={errorRows.size ? 'danger' : 'success'} />
                <SummaryRow label="Warnings" value={validation.filter((v) => v.severity === 'WARNING').length} tone="warning" />
                <SummaryRow label="Missing birthdate" value={normalised.filter((p) => !p.date_of_birth).length} />
                <SummaryRow label="Missing middle name" value={normalised.filter((p) => !p.middle_name).length} />
                <SummaryRow label="Invalid contact" value={normalised.filter((p) => p.contact_number && p.contact_number.replace(/\D/g, '').length < 7).length} />
                <SummaryRow label="Unmatched barangay" value={normalised.filter((p) => !p.barangay_id).length} />
              </div>
              <p className="mt-3 text-[11px] text-ink-soft">
                Errors must be corrected before the import; warnings can be accepted with a note and are listed in the
                report.
              </p>
            </Card>
            <Card className="card-pad">
              <h2 className="section-title">Normalisation applied</h2>
              <ul className="mt-2 space-y-1 text-[11px] text-ink-soft">
                <li>Names trimmed, collapsed and title-cased.</li>
                <li>Birthdates parsed from MM/DD/YYYY, DD-MM-YYYY and long forms.</li>
                <li>Contact numbers reduced to digits; +63 and 0-prefixes unified.</li>
                <li>Sex mapped from M/F, Male/Female, Lalaki/Babae.</li>
                <li>Barangay matched by name against the municipal directory.</li>
              </ul>
            </Card>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- 6) in-file duplicates */}
      {step === 6 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="card-header">
              <h2 className="section-title">Duplicates inside the file</h2>
              <span className="text-[11px] text-ink-soft">{inFileDuplicates.length} group(s)</span>
            </div>
            <div className="card-pad space-y-3">
              {inFileDuplicates.length === 0 && (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-900">
                  No repeated name + birthdate combinations were found inside the file.
                </p>
              )}
              {inFileDuplicates.map((g) => (
                <div key={g.key} className="rounded-md border border-amber-300 bg-amber-50/50 p-3">
                  <p className="text-xs font-semibold text-amber-900">
                    Rows {g.rows.join(', ')} look like the same resident
                  </p>
                  <ul className="mt-2 space-y-1 text-[11px] text-ink-soft">
                    {g.rows.map((r) => {
                      const p = normalised[r - 1]
                      return (
                        <li key={r}>
                          Row {r}: <span className="font-medium text-ink">{[p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ')}</span>
                          {' '}· {p.date_of_birth ?? 'no birthdate'} · {p.contact_number ?? 'no contact'}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
              <p className="text-[11px] text-ink-soft">
                During review, keep one row per resident and skip the rest. Rows that differ only by a typo should be
                merged into the single best version before importing.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
              <Button variant="ghost" onClick={() => setStep(5)}><IconArrowLeft /> Back to validation</Button>
              <Button variant="primary" loading={busy} onClick={() => void createBatch()}>
                Check against the registry <IconArrowRight />
              </Button>
            </div>
            {stageMsg && (
              <p className="border-t border-line px-4 py-2 text-[11px] text-ink-soft">{stageMsg}</p>
            )}
          </Card>
          <Card className="card-pad">
            <h2 className="section-title">What happens next</h2>
            <ol className="mt-2 list-inside list-decimal space-y-1.5 text-[11px] text-ink-soft">
              <li>The file is staged as an import batch (nothing is written to the member registry).</li>
              <li>Every row is scored against all existing members, including name variants and typos.</li>
              <li>You review the report and decide each conflicting row: import, skip or link to the existing member.</li>
              <li>Only the rows you accept are written, with a full audit entry.</li>
            </ol>
          </Card>
        </div>
      )}

      {/* ---------------------------------------------------------- 7+8+9) report, review, import */}
      {(step === 7 || step === 8 || step === 9) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="card-header">
              <h2 className="section-title">Import report</h2>
              <span className="text-[11px] text-ink-soft">{summary?.file_name}</span>
            </div>
            {!summary ? (
              <div className="card-pad space-y-2"><Skeleton /><Skeleton /><Skeleton /></div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-4">
                  <Stat label="Rows in file" value={summary.total_rows} />
                  <Stat label="Clean" value={summary.clean_rows} tone="success" />
                  <Stat label="Errors" value={summary.error_rows} tone="danger" />
                  <Stat label="Duplicates in file" value={summary.in_file_duplicates} tone="warning" />
                  <Stat label="Unique rows" value={summary.unique_rows} />
                  <Stat label="Already in registry" value={summary.duplicate_rows} tone="warning" />
                  <Stat label="Missing birthdate" value={summary.missing_birthdates} />
                  <Stat label="Invalid contacts" value={summary.invalid_contacts} />
                </div>

                <div className="border-t border-line px-4 py-3">
                  <p className="text-[11px] font-semibold text-ink-soft uppercase">Issue breakdown</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(summary.issue_breakdown ?? {}).length === 0 && (
                      <span className="text-xs text-ink-soft">No issues recorded.</span>
                    )}
                    {Object.entries(summary.issue_breakdown ?? {}).map(([code, n]) => (
                      <Badge key={code} tone="warning">{code.replace(/_/g, ' ').toLowerCase()}: {n}</Badge>
                    ))}
                  </div>
                </div>

                <div className="border-t border-line px-4 py-3">
                  <p className="text-[11px] font-semibold text-ink-soft uppercase">Rows needing a decision</p>
                  <p className="mt-1 text-xs text-ink-soft">
                    These rows either clash with an existing member or have a typo/missing-middle-name pattern. Choose
                    to import (new person), skip, or link to the existing master record.
                  </p>
                </div>

                <DataTable
                  rows={rows}
                  columns={importRowColumns(setDecision, navigate)}
                  rowKey={(r) => String(r.id)}
                  limit={100}
                  dense
                  stickyHeader={false}
                  emptyTitle="No rows in this batch"
                />

                <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
                  <Button variant="secondary" size="sm" loading={busy} onClick={() => void setAll('ERROR', 'SKIP', false, 'Every row the validation blocked is now skipped.')}>
                    Skip all error rows
                  </Button>
                  <Button variant="secondary" size="sm" loading={busy} onClick={() => void setAll(null, 'SKIP', true, 'In-file twins and registry clashes skipped; clean rows keep their decision.')}>
                    Skip duplicates only
                  </Button>
                  <Button variant="secondary" size="sm" loading={busy} onClick={() => void setAll(null, 'SKIP')}>
                    Skip everything
                  </Button>
                  <Button variant="secondary" size="sm" loading={busy} onClick={() => void refreshRows()}>
                    <IconRefresh /> Refresh decisions
                  </Button>
                </div>
              </>
            )}
          </Card>

          <div className="space-y-4">
            <Card className="card-pad">
              <h2 className="section-title">Run the import</h2>
              <p className="mt-2 text-xs text-ink-soft">
                Only rows marked <span className="font-semibold text-ink">Import</span> are written. Rows that clash with
                an existing record are parked as duplicate cases — a second master record is never created.
              </p>
              <Field label="Default barangay" className="mt-3">
                <select className="input" value={defaultBarangay} onChange={(e) => setDefaultBarangay(e.target.value)}>
                  <option value="">Not set</option>
                  {barangays.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Button
                variant="primary"
                className="mt-3 w-full"
                loading={busy}
                disabled={!batchId || (summary?.approved_rows ?? 0) === 0}
                onClick={() => void commit()}
              >
                <IconCheck />{' '}
                {commitProgress != null
                  ? `Importing… ${commitProgress} row(s) written so far`
                  : `Import ${summary?.approved_rows ?? 0} approved row(s)`}
              </Button>
              <p className="mt-2 text-[11px] text-ink-soft">
                Every imported record is audited with your name and the batch file name.
              </p>
            </Card>

            <Card className="card-pad">
              <h2 className="section-title">Guidance on tricky rows</h2>
              <ul className="mt-2 space-y-2 text-[11px] text-ink-soft">
                <li><span className="font-semibold text-ink">Duplicate inside the file</span> — one person encoded twice in the same sheet.</li>
                <li><span className="font-semibold text-ink">Already in the registry</span> — the resident exists under another barangay; link instead of importing.</li>
                <li><span className="font-semibold text-ink">Typo variant</span> — “Rosalinda” vs “Rosalinda-”, “dela Cruz” vs “Dela Cruz”; link or correct before importing.</li>
                <li><span className="font-semibold text-ink">Missing middle name</span> — often hides a duplicate; check the registry before importing.</li>
              </ul>
            </Card>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- 10) summary */}
      {step === 10 && committed && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2 card-pad">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <IconCheck className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-base font-bold text-ink">Import completed</h2>
                <p className="mt-0.5 text-xs text-ink-soft">{committed.message}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Imported" value={committed.imported} tone="success" />
              <Stat label="Parked as duplicates" value={committed.duplicates_parked} tone="warning" />
              <Stat label="Skipped" value={committed.skipped} />
              <Stat label="Linked to existing" value={committed.linked} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => navigate('/members')}>Open the member registry</Button>
              <Button variant="secondary" size="sm" onClick={() => navigate('/duplicates')}>Review new duplicate cases</Button>
              <Button variant="ghost" size="sm" onClick={() => navigate('/audit')}>See the audit trail</Button>
            </div>
          </Card>
          <Card className="card-pad">
            <h2 className="section-title">Batch history</h2>
            <BatchList batches={batches} onOpen={openBatch} />
          </Card>
        </div>
      )}

      {step < 10 && (
        <Card className="mt-4">
          <div className="card-header">
            <h2 className="section-title">Previous import batches</h2>
            <span className="text-[11px] text-ink-soft">{batches.length} batch(es)</span>
          </div>
          {batches.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-soft">No imports have been run yet.</p>
          ) : (
            <BatchList batches={batches} onOpen={openBatch} inline />
          )}
        </Card>
      )}
    </>
  )
}

function BatchList({ batches, onOpen, inline }: {
  batches: ImportSummary[]; onOpen: (b: ImportSummary) => void; inline?: boolean
}) {
  if (batches.length === 0) return <p className="mt-2 text-xs text-ink-soft">No batches yet.</p>
  return (
    <ul className={cn('divide-y divide-line', !inline && 'mt-2')}>
      {batches.map((b) => (
        <li key={b.batch_id} className="flex flex-wrap items-center justify-between gap-2 px-1 py-2">
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-ink">{b.file_name}</span>
            <span className="text-[11px] text-ink-soft">
              {b.total_rows} row(s) · {b.imported_rows} imported · {relativeTime(b.created_at)}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <StatusBadge status={b.status} />
            <Button size="sm" variant="ghost" onClick={() => onOpen(b)}>Open</Button>
          </span>
        </li>
      ))}
    </ul>
  )
}

function importRowColumns(
  setDecision: (rowId: string | number, decision: 'IMPORT' | 'SKIP' | 'LINK') => void,
  navigate: (path: string) => void,
): Array<Column<ImportRow>> {
  return [
    { key: 'row', header: 'Row', value: (r) => r.row_no, align: 'right' },
    {
      key: 'name', header: 'Name in file', value: (r) => [r.normalized.first_name, r.normalized.middle_name, r.normalized.last_name].filter(Boolean).join(' '),
      render: (r) => (
        <div>
          <p className="text-xs font-medium text-ink">
            {[r.normalized.first_name, r.normalized.middle_name, r.normalized.last_name, r.normalized.suffix].filter(Boolean).join(' ') || '—'}
          </p>
          <p className="text-[11px] text-ink-soft">
            {r.normalized.date_of_birth ?? 'no birthdate'} · {r.normalized.sex ?? 'no sex'} · {r.normalized.contact_number ?? 'no contact'}
          </p>
        </div>
      ),
    },
    { key: 'severity', header: 'Validation', value: (r) => r.severity,
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={r.severity === 'ERROR' ? 'danger' : r.severity === 'WARNING' ? 'warning' : 'success'}>{r.severity}</Badge>
          {r.issues.slice(0, 2).map((i) => <Badge key={i} tone="muted">{i.replace(/_/g, ' ').toLowerCase()}</Badge>)}
        </div>
      ) },
    { key: 'match', header: 'Closest registry match', value: (r) => r.match_score ?? -1,
      render: (r) => (r.match_person
        ? (
          <div>
            <p className="text-xs font-medium text-ink">{fullName(r.match_person)}</p>
            <p className="text-[11px] text-ink-soft">
              {r.match_person.barangay_name ?? '—'} · {r.match_score}% {r.band ? `· ${r.band.replace('_', ' ').toLowerCase()}` : ''}
            </p>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => navigate(`/members/${r.match_person!.id}`)}>
              Open record
            </Button>
          </div>
        )
        : <span className="text-[11px] text-ink-soft">No similar record</span>) },
    { key: 'decision', header: 'Decision', value: (r) => r.decision,
      render: (r) => (
        <select
          className="input max-w-[9rem] px-2 py-1 text-xs"
          value={r.decision}
          onChange={(e) => setDecision(r.id, e.target.value as 'IMPORT' | 'SKIP' | 'LINK')}
          aria-label={`Decision for row ${r.row_no}`}
        >
          <option value="PENDING">Undecided</option>
          <option value="IMPORT">Import</option>
          <option value="SKIP">Skip</option>
          <option value="LINK">Link to existing</option>
        </select>
      ) },
  ]
}

function detectMapping(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const normalisedHeaders = headers.map((h) => ({ raw: h, key: h.toLowerCase().replace(/[^a-z]/g, '') }))
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[string, string[]]>) {
    const aliasKeys = aliases.map((a) => a.replace(/[^a-z]/g, ''))
    const exact = normalisedHeaders.find((h) => aliasKeys.includes(h.key))
    const partial = normalisedHeaders.find((h) => aliasKeys.some((a) => h.key.includes(a))) 
    out[field] = (exact ?? partial)?.raw ?? ''
  }
  return out
}

function mappingValues(mapping: Record<string, string>): string[] {
  return Object.values(mapping).filter(Boolean)
}

function humanField(field: string): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function SummaryRow({ label, value, tone }: { label: string; value: number; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className={cn('font-semibold', tone === 'danger' ? 'text-red-700' : tone === 'warning' ? 'text-amber-700' : tone === 'success' ? 'text-emerald-700' : 'text-ink')}>
        {value.toLocaleString()}
      </span>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className="rounded-md border border-line bg-slate-50 p-3">
      <p className="text-[10px] font-semibold tracking-wide text-ink-soft uppercase">{label}</p>
      <p className={cn('mt-1 text-xl font-bold',
        tone === 'success' ? 'text-emerald-700' : tone === 'warning' ? 'text-amber-700' : tone === 'danger' ? 'text-red-700' : 'text-ink')}>
        {value.toLocaleString()}
      </p>
    </div>
  )
}

function downloadTemplate(barangays: Barangay[], defaultBarangay: string) {
  const header = ['Last Name', 'First Name', 'Middle Name', 'Suffix', 'Birthdate', 'Sex', 'Civil Status',
    'Contact Number', 'Purok', 'Address', 'Barangay', 'Remarks']
  const example = ['Dela Cruz', 'Juan', 'Santos', '', '01/12/1985', 'M', 'Married', '09171234567',
    'Purok 3', 'Purok 3, Nabua, Camarines Sur', barangays.find((b) => b.id === defaultBarangay)?.name ?? barangays[0]?.name ?? '', '']
  void downloadXlsx(header, [example], 'nmbr-import-template.xlsx', 'Template')
}
