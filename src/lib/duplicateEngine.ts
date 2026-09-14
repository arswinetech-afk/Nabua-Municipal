/**
 * DUPLICATE DETECTION ENGINE (client mirror of the PostgreSQL implementation).
 *
 * Used for:
 *  - live "search before adding" checks (debounced, runs against the local cache)
 *  - offline duplicate checking when the office connection is down
 *  - import validation (duplicates inside the file and against the registry)
 *
 * The authoritative check always runs inside PostgreSQL (fn_check_duplicates +
 * the identity guard trigger). This module never decides on its own whether a
 * record may be written; it only advises the encoder.
 */
import {
  fullName,
  identityKey,
  normalizeContact,
  normalizeDate,
  normalizeText,
  nameFieldSimilarity,
  trigramSimilarity,
  tokenSetSimilarity,
} from './normalize'

export type DuplicateWeights = {
  last_name: number
  first_name: number
  middle_name: number
  date_of_birth: number
  sex: number
  barangay: number
  address: number
  contact: number
}

export type DuplicateThresholds = {
  /** 95 default — block/require review */
  block: number
  /** 80 default — strong warning + confirmation */
  warn: number
  /** 60 default — notice + explicit confirmation */
  notice: number
}

export const DEFAULT_WEIGHTS: DuplicateWeights = {
  last_name: 26,
  first_name: 22,
  middle_name: 8,
  date_of_birth: 20,
  sex: 5,
  barangay: 6,
  address: 8,
  contact: 5,
}

export const DEFAULT_THRESHOLDS: DuplicateThresholds = { block: 95, warn: 80, notice: 60 }

export type MatchBand = 'VERY_LIKELY' | 'POSSIBLE' | 'POTENTIAL' | 'DISTINCT'

export const BAND_META: Record<MatchBand, { label: string; short: string; tone: string; description: string }> = {
  VERY_LIKELY: {
    label: 'VERY LIKELY DUPLICATE',
    short: 'Very likely',
    tone: 'danger',
    description:
      'An existing member with highly similar information was found. Creation is blocked until this is reviewed.',
  },
  POSSIBLE: {
    label: 'POSSIBLE DUPLICATE',
    short: 'Possible',
    tone: 'warning',
    description: 'Strong similarity with an existing member. Confirmation is required before saving.',
  },
  POTENTIAL: {
    label: 'POTENTIAL MATCH',
    short: 'Potential',
    tone: 'info',
    description: 'Some fields are similar. Creation is allowed only after explicit confirmation.',
  },
  DISTINCT: {
    label: 'PROBABLY NEW RECORD',
    short: 'New',
    tone: 'neutral',
    description: 'No meaningful similarity found with existing records.',
  },
}

export type ReasonStatus = 'match' | 'partial' | 'mismatch' | 'conflict' | 'unknown'

export type MatchReason = {
  field: string
  label: string
  status: ReasonStatus
  detail: string
  similarity: number
  weight: number
}

export type DuplicateFlags = {
  identityMatch: boolean
  dobConflict: boolean
  sexConflict: boolean
  dobUnknown: boolean
  contactMatch: boolean
  nameOnlyMatch: boolean
  cappedBy?: string
}

export type DuplicateScore = {
  score: number
  band: MatchBand
  reasons: MatchReason[]
  flags: DuplicateFlags
  matchedFields: string[]
}

export type PersonComparable = {
  id: string
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  suffix: string | null
  date_of_birth: string | null
  sex: string | null
  purok?: string | null
  address?: string | null
  contact_number?: string | null
  barangay_id?: string | null
  barangay_name?: string | null
  status?: string | null
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

function bandFor(score: number, t: DuplicateThresholds): MatchBand {
  if (score >= t.block) return 'VERY_LIKELY'
  if (score >= t.warn) return 'POSSIBLE'
  if (score >= t.notice) return 'POTENTIAL'
  return 'DISTINCT'
}

export function bandLabel(band: MatchBand): string {
  return BAND_META[band].label
}

function statusForComponent(sim: number, unknown = false): ReasonStatus {
  if (unknown) return 'unknown'
  if (sim >= 0.95) return 'match'
  if (sim >= 0.6) return 'partial'
  return 'mismatch'
}

/**
 * Compare one candidate record against one existing record.
 * Returns a 0..100 confidence score plus a human-readable explanation of WHY
 * the pair matched (requirement 6 of the specification).
 */
export function scorePair(
  candidate: PersonComparable,
  existing: PersonComparable,
  options?: { weights?: Partial<DuplicateWeights>; thresholds?: DuplicateThresholds; barangayAware?: boolean },
): DuplicateScore {
  const w = { ...DEFAULT_WEIGHTS, ...(options?.weights ?? {}) }
  const t = options?.thresholds ?? DEFAULT_THRESHOLDS
  const reasons: MatchReason[] = []

  const cKey = identityKey(candidate)
  const eKey = identityKey(existing)
  const identityMatch = cKey === eKey && !!normalizeDate(candidate.date_of_birth) && !!normalizeText(candidate.last_name)

  const last = nameFieldSimilarity(candidate.last_name, existing.last_name)
  const first = nameFieldSimilarity(candidate.first_name, existing.first_name)
  const middle = nameFieldSimilarity(candidate.middle_name, existing.middle_name)

  const cDob = normalizeDate(candidate.date_of_birth)
  const eDob = normalizeDate(existing.date_of_birth)
  const dobUnknown = !cDob || !eDob
  const dobConflict = !!cDob && !!eDob && cDob !== eDob
  const dobSim = dobUnknown ? 0.45 : dobConflict ? 0 : 1

  const cSex = normalizeText(candidate.sex)
  const eSex = normalizeText(existing.sex)
  const sexUnknown = !cSex || !eSex || cSex === 'UNKNOWN'
  const sexConflict = !sexUnknown && cSex !== eSex
  const sexSim = sexUnknown ? 0.5 : sexConflict ? 0 : 1

  const cBrgy = normalizeText(candidate.barangay_name ?? '')
  const eBrgy = normalizeText(existing.barangay_name ?? '')
  const brgySim = !cBrgy || !eBrgy ? 0.5 : cBrgy === eBrgy ? 1 : 0

  const cAddr = normalizeText(`${candidate.purok ?? ''} ${candidate.address ?? ''}`)
  const eAddr = normalizeText(`${existing.purok ?? ''} ${existing.address ?? ''}`)
  const addrSim = !cAddr || !eAddr ? 0.5 : Math.max(trigramSimilarity(cAddr, eAddr), tokenSetSimilarity(cAddr, eAddr))

  const cContact = normalizeContact(candidate.contact_number)
  const eContact = normalizeContact(existing.contact_number)
  const contactMatch = !!cContact && !!eContact && cContact === eContact && cContact.length >= 7
  const contactBoth = !!cContact && !!eContact
  const contactUnknown = !cContact || !eContact
  const contactSim = contactUnknown ? 0.5 : contactMatch ? 1 : 0.15

  const parts: Array<[string, string, number, number, ReasonStatus, string]> = [
    ['last_name', 'Last name', last.score, w.last_name, statusForComponent(last.score, !normalizeText(candidate.last_name) || !normalizeText(existing.last_name)), describe(last, candidate.last_name, existing.last_name)],
    ['first_name', 'First name', first.score, w.first_name, statusForComponent(first.score, !normalizeText(candidate.first_name) || !normalizeText(existing.first_name)), describe(first, candidate.first_name, existing.first_name)],
    ['middle_name', 'Middle name', middle.score, w.middle_name, !normalizeText(candidate.middle_name) || !normalizeText(existing.middle_name) ? 'unknown' : statusForComponent(middle.score), describe(middle, candidate.middle_name, existing.middle_name)],
    ['date_of_birth', 'Date of birth', dobSim, w.date_of_birth, dobUnknown ? 'unknown' : dobConflict ? 'conflict' : 'match', dobUnknown ? 'Date of birth missing on one record' : dobConflict ? `Different dates: ${fmtDate(cDob)} vs ${fmtDate(eDob)}` : `Both ${fmtDate(cDob)}`],
    ['sex', 'Sex', sexSim, w.sex, sexUnknown ? 'unknown' : sexConflict ? 'conflict' : 'match', sexUnknown ? 'Sex not recorded on one record' : sexConflict ? `${candidate.sex} vs ${existing.sex}` : `Both ${candidate.sex}`],
    ['barangay', 'Barangay', brgySim, w.barangay, !cBrgy || !eBrgy ? 'unknown' : brgySim === 1 ? 'match' : 'mismatch', !cBrgy || !eBrgy ? 'Barangay not indicated' : brgySim === 1 ? `Same barangay (${existing.barangay_name})` : `Different barangay (${existing.barangay_name ?? '—'})`],
    ['address', 'Address / Purok', addrSim, w.address, statusForComponent(addrSim, !cAddr || !eAddr), !cAddr || !eAddr ? 'Address incomplete' : `Address similarity ${Math.round(addrSim * 100)}%`],
    ['contact_number', 'Contact number', contactSim, w.contact, contactUnknown ? 'unknown' : contactMatch ? 'match' : 'mismatch', contactUnknown ? 'Contact number missing on one record' : contactMatch ? 'Contact numbers match' : 'Contact numbers differ'],
  ]

  let base = 0
  for (const [, , sim, weight] of parts) base += sim * weight

  const flags: DuplicateFlags = {
    identityMatch,
    dobConflict,
    sexConflict,
    dobUnknown,
    contactMatch,
    nameOnlyMatch: last.score >= 0.95 && first.score >= 0.95 && (dobConflict || dobUnknown),
  }

  let score = base
  let cappedBy: string | undefined

  if (identityMatch) {
    score = 100
  } else {
    if (contactMatch) score += 8
    if (contactBoth && !contactMatch) score *= 0.96
    if (dobConflict) {
      score *= 0.75
      score = Math.min(score, 74)
      if (last.score >= 0.95 && first.score >= 0.95) score = Math.max(score, 62)
      cappedBy = 'date_of_birth_conflict'
    }
    if (sexConflict) {
      score *= 0.65
      score = Math.min(score, 84)
      cappedBy = cappedBy ? `${cappedBy},sex_conflict` : 'sex_conflict'
    }
    if (dobUnknown && !dobConflict) {
      // Missing birthdate must never be allowed to hard-block a record.
      score = Math.min(score, 88)
      cappedBy = cappedBy ? `${cappedBy},date_of_birth_unknown` : 'date_of_birth_unknown'
    }
  }

  score = Math.round(clamp(score))
  flags.cappedBy = cappedBy

  for (const [field, label, sim, weight, status, detail] of parts) {
    reasons.push({ field, label, status, detail, similarity: Math.round(sim * 100) / 100, weight })
  }

  return {
    score,
    band: bandFor(score, t),
    reasons,
    flags,
    matchedFields: reasons.filter((r) => r.status === 'match').map((r) => r.field),
  }
}

function describe(sim: { score: number; reason: string }, a?: string | null, b?: string | null): string {
  switch (sim.reason) {
    case 'exact':
      return 'Exact match after normalisation'
    case 'phonetic':
      return `Sounds the same (${a ?? '—'} ≈ ${b ?? '—'})`
    case 'near':
      return `${Math.round(sim.score * 100)}% similar (${a ?? '—'} ≈ ${b ?? '—'})`
    case 'partial':
      return `Partially similar — ${Math.round(sim.score * 100)}% (${a ?? '—'} ≈ ${b ?? '—'})`
    case 'weak':
      return `Weak similarity — ${Math.round(sim.score * 100)}% (${a ?? '—'} ≈ ${b ?? '—'})`
    case 'unknown':
      return 'Not recorded on one record'
    default:
      return `Different (${a ?? '—'} vs ${b ?? '—'})`
  }
}

function fmtDate(iso: string): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y}`
}

export type DuplicateMatch = {
  person: PersonComparable
  score: DuplicateScore
}

/**
 * Compare a candidate against a pool of existing records and return ranked matches.
 * Optionally restricts the pool (e.g. a single barangay) for offline checks.
 */
export function findDuplicates(
  candidate: PersonComparable,
  pool: PersonComparable[],
  options?: {
    weights?: Partial<DuplicateWeights>
    thresholds?: DuplicateThresholds
    minScore?: number
    limit?: number
    excludeId?: string
  },
): DuplicateMatch[] {
  const thresholds = options?.thresholds ?? DEFAULT_THRESHOLDS
  const minScore = options?.minScore ?? Math.max(0, thresholds.notice - 25)
  const limit = options?.limit ?? 25
  const results: DuplicateMatch[] = []
  for (const p of pool) {
    if (options?.excludeId && p.id === options.excludeId) continue
    if (p.status === 'ARCHIVED') continue
    const score = scorePair(candidate, p, { weights: options?.weights, thresholds })
    if (score.score >= minScore) results.push({ person: p, score })
  }
  results.sort((a, b) => b.score.score - a.score.score || fullName(a.person).localeCompare(fullName(b.person)))
  return results.slice(0, limit)
}

/** Highest scoring match, or null. */
export function topMatch(matches: DuplicateMatch[]): DuplicateMatch | null {
  return matches.length ? matches[0] : null
}

export const AGE_GROUPS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: '0-4', label: 'Under 5', min: 0, max: 4 },
  { key: '5-12', label: '5–12 (Child)', min: 5, max: 12 },
  { key: '13-17', label: '13–17 (Adolescent)', min: 13, max: 17 },
  { key: '18-29', label: '18–29 (Young adult)', min: 18, max: 29 },
  { key: '30-44', label: '30–44 (Adult)', min: 30, max: 44 },
  { key: '45-59', label: '45–59 (Middle age)', min: 45, max: 59 },
  { key: '60-74', label: '60–74 (Senior)', min: 60, max: 74 },
  { key: '75+', label: '75 and above', min: 75, max: 200 },
]

export function ageFrom(dob?: string | null, on = new Date()): number | null {
  const iso = normalizeDate(dob)
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00')
  let age = on.getFullYear() - d.getFullYear()
  const m = on.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && on.getDate() < d.getDate())) age--
  return age < 0 ? null : age
}

export function ageGroupOf(dob?: string | null): string | null {
  const age = ageFrom(dob)
  if (age === null) return null
  return AGE_GROUPS.find((g) => age >= g.min && age <= g.max)?.key ?? null
}
