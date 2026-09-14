/**
 * Aggregations computed in the browser.
 *
 * Used by the offline backend and by the dashboard's "queued changes" view.
 * The connected deployment gets the same numbers from PostgreSQL
 * (fn_dashboard_stats / fn_data_quality / fn_reports) so both paths agree.
 */
import type { Barangay, DashboardStats, DataQualityRow, DuplicateCase, Person, PersonStatus } from './types'
import { normalizeDate, normalizeDigits, normalizeText } from './normalize'
import { AGE_GROUPS, ageFrom } from './duplicateEngine'
import { isToday } from './utils'

export function live(p: Person): boolean {
  return p.status !== 'ARCHIVED' && !p.merged_into
}

export function dashboardStats(
  persons: Person[],
  barangays: Barangay[],
  cases: DuplicateCase[],
  audit: Array<{ action: string; timestamp: string }>,
): DashboardStats {
  const people = persons.filter(live)
  const pending = cases.filter((c) => c.status === 'PENDING')
  return {
    total_barangays: barangays.length,
    active_barangays: barangays.filter((b) => b.active).length,
    total_members: people.length,
    active_members: people.filter((p) => p.status === 'ACTIVE').length,
    new_today: people.filter((p) => isToday(p.created_at)).length,
    updated_today: audit.filter((a) => a.action === 'UPDATED' && isToday(a.timestamp)).length,
    possible_duplicates: pending.length,
    pending_duplicate_cases: pending.length,
    records_requiring_attention: people.filter((p) => needsAttention(p, pending)).length,
    archived_records: persons.filter((p) => p.status === 'ARCHIVED').length,
    last_sync_at: null,
  }
}

export function needsAttention(p: Person, pendingCases: DuplicateCase[]): boolean {
  return (
    p.status === 'FOR_REVIEW' ||
    !p.date_of_birth ||
    !p.sex ||
    !p.barangay_id ||
    !p.address ||
    (!!p.contact_number && normalizeDigits(p.contact_number).length > 0 && normalizeDigits(p.contact_number).length < 7) ||
    pendingCases.some((c) => c.person_id_a === p.id || c.person_id_b === p.id)
  )
}

export function barangayOverview(persons: Person[], barangays: Barangay[], cases: DuplicateCase[]): Barangay[] {
  const pending = cases.filter((c) => c.status === 'PENDING')
  return barangays.map((b) => {
    const members = persons.filter((p) => p.barangay_id === b.id && live(p))
    return {
      ...b,
      total_members: members.length,
      active_members: members.filter((p) => p.status === 'ACTIVE').length,
      new_today: members.filter((p) => isToday(p.created_at)).length,
      for_review: members.filter((p) => p.status === 'FOR_REVIEW').length,
      possible_duplicates: pending.filter((c) => {
        const a = persons.find((p) => p.id === c.person_id_a)
        const b2 = persons.find((p) => p.id === c.person_id_b)
        return a?.barangay_id === b.id || b2?.barangay_id === b.id
      }).length,
      last_updated: members.reduce<string | null>(
        (acc, p) => (!acc || p.updated_at > acc ? p.updated_at : acc), null),
    }
  })
}

function invalidContact(p: Person): boolean {
  if (!p.contact_number) return false
  const d = normalizeDigits(p.contact_number)
  return d.length > 0 && d.length < 7
}

export function dataQuality(persons: Person[], cases: DuplicateCase[]): DataQualityRow[] {
  const people = persons.filter(live)
  const pending = cases.filter((c) => c.status === 'PENDING')
  const contactGroups = new Map<string, number>()
  for (const p of people) {
    const c = normalizeDigits(p.contact_number)
    if (c.length >= 7) contactGroups.set(c, (contactGroups.get(c) ?? 0) + 1)
  }
  const sharedContacts = [...contactGroups.values()].filter((n) => n > 1).reduce((a, b) => a + (b - 1), 0)
  const nameDob = new Map<string, Set<string>>()
  for (const p of people) {
    if (!p.date_of_birth) continue
    const key = normalizeText(`${p.first_name} ${p.middle_name ?? ''} ${p.last_name}`)
    if (!nameDob.has(key)) nameDob.set(key, new Set())
    nameDob.get(key)!.add(normalizeDate(p.date_of_birth))
  }
  const sameNameDiffDob = [...nameDob.values()].filter((s) => s.size > 1).reduce((a, s) => a + (s.size - 1), 0)

  return [
    {
      id: 'possible_duplicates', label: 'Possible duplicates', severity: 'high',
      description: 'Open duplicate cases awaiting review.', count: pending.length,
    },
    {
      id: 'missing_birthdate', label: 'Missing birthdates', severity: 'medium',
      description: 'Records without a date of birth — weakens duplicate detection.',
      count: people.filter((p) => !p.date_of_birth).length,
    },
    {
      id: 'missing_sex', label: 'Missing sex', severity: 'medium',
      description: 'Records without sex recorded.',
      count: people.filter((p) => !p.sex).length,
    },
    {
      id: 'missing_barangay', label: 'Missing barangay', severity: 'high',
      description: 'Members not assigned to any barangay.',
      count: people.filter((p) => !p.barangay_id).length,
    },
    {
      id: 'invalid_contact', label: 'Invalid contact numbers', severity: 'medium',
      description: 'Contact numbers with fewer than 7 digits.',
      count: people.filter(invalidContact).length,
    },
    {
      id: 'duplicate_contact', label: 'Shared contact numbers', severity: 'low',
      description: 'One number used by several records — families often share a number.',
      count: sharedContacts,
    },
    {
      id: 'incomplete_address', label: 'Incomplete addresses', severity: 'low',
      description: 'Records with no address or no purok recorded.',
      count: people.filter((p) => !p.address || !p.purok).length,
    },
    {
      id: 'inconsistent_names', label: 'Inconsistent names', severity: 'low',
      description: 'Stored name differs from the normalised municipal form (extra spaces, odd casing).',
      count: people.filter(
        (p) => normalizeText(`${p.first_name} ${p.middle_name ?? ''} ${p.last_name} ${p.suffix ?? ''}`) !==
          normalizeText(`${p.first_name} ${p.middle_name ?? ''} ${p.last_name} ${p.suffix ?? ''}`.trim()),
      ).length +
        people.filter((p) => /\s{2,}/.test(`${p.first_name}${p.middle_name ?? ''}${p.last_name}`) ||
          p.first_name !== p.first_name.trim() || p.last_name !== p.last_name.trim()).length,
    },
    {
      id: 'for_review', label: 'Records flagged for review', severity: 'high',
      description: 'Records raised during duplicate handling.',
      count: people.filter((p) => p.status === 'FOR_REVIEW').length,
    },
    {
      id: 'archived', label: 'Archived records', severity: 'low',
      description: 'Soft-deleted or merged records retained for the audit trail.',
      count: persons.filter((p) => p.status === 'ARCHIVED').length,
    },
    {
      id: 'same_name_different_dob', label: 'Same name, different birthdate', severity: 'medium',
      description: 'Records sharing a full name but with conflicting birthdates — worth a spot check.',
      count: sameNameDiffDob,
    },
  ]
}

export function qualityRecords(
  metric: string, persons: Person[], limit = 100,
): Array<Record<string, unknown>> {
  const people = persons.filter(live)
  if (metric === 'duplicate_contact') {
    const groups = new Map<string, Person[]>()
    for (const p of people) {
      const c = normalizeDigits(p.contact_number)
      if (c.length >= 7) groups.set(c, [...(groups.get(c) ?? []), p])
    }
    return [...groups.entries()]
      .filter(([, list]) => list.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, limit)
      .map(([contact, members]) => ({ contact, members }))
  }
  if (metric === 'same_name_different_dob') {
    const groups = new Map<string, Person[]>()
    for (const p of people) {
      if (!p.date_of_birth) continue
      const key = normalizeText(`${p.first_name} ${p.middle_name ?? ''} ${p.last_name}`)
      groups.set(key, [...(groups.get(key) ?? []), p])
    }
    return [...groups.entries()]
      .filter(([, list]) => new Set(list.map((p) => p.date_of_birth)).size > 1)
      .slice(0, limit)
      .map(([name, members]) => ({ name, members }))
  }
  return []
}

export function statusCounts(persons: Person[]): Record<PersonStatus | 'TOTAL', number> {
  const base = { ACTIVE: 0, INACTIVE: 0, TRANSFERRED: 0, DECEASED: 0, FOR_REVIEW: 0, ARCHIVED: 0, TOTAL: 0 }
  for (const p of persons) {
    if (!live(p)) {
      if (p.status === 'ARCHIVED') base.ARCHIVED++
      continue
    }
    base[p.status] = (base[p.status] ?? 0) + 1
    base.TOTAL++
  }
  return base
}

export function ageGroupCounts(persons: Person[]): Array<{ group: string; total: number }> {
  const people = persons.filter(live)
  const out = AGE_GROUPS.map((g) => ({ group: g.label, total: 0 }))
  let unknown = 0
  for (const p of people) {
    const age = ageFrom(p.date_of_birth)
    if (age === null) {
      unknown++
      continue
    }
    const idx = AGE_GROUPS.findIndex((g) => age >= g.min && age <= g.max)
    if (idx >= 0) out[idx].total++
  }
  out.push({ group: 'Not recorded', total: unknown })
  return out
}

export function sexCounts(persons: Person[]): Array<{ sex: string; total: number }> {
  const people = persons.filter(live)
  const map = new Map<string, number>()
  for (const p of people) {
    const key = p.sex ?? 'NOT RECORDED'
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()].map(([sex, total]) => ({ sex, total })).sort((a, b) => b.total - a.total)
}
