/**
 * LOCAL (offline) BACKEND.
 *
 * A complete, self-contained implementation of RegistryApi that runs entirely in
 * the browser: office PCs keep encoding members when the internet is down or the
 * Supabase free-tier is paused, and the queued work is pushed when connectivity
 * returns.
 *
 * It enforces the SAME rules as PostgreSQL:
 *   • one master person record per identity (deterministic identity key)
 *   • the same fuzzy scoring engine (src/lib/duplicateEngine.ts)
 *   • never hard-delete; archive/merge only
 *   • every mutation is written to the audit trail
 *
 * Storage: localStorage (compact JSON). The registry index is stored, not a full
 * dump of history, to keep memory small on office desktops and phones.
 */
import seed from '../data/seed.json'
import type {
  AuditLogRow, Barangay, DataQualityRow, DuplicateCase, DashboardStats, Household, ManagedUser,
  OutboxItem, Person, PersonIndexRow, PersonStatus, SystemSettings,
  SubsidyProgram, SubsidyBeneficiary,
} from './types'
import type {
  ApiResult, CreatePersonResult, DuplicateComparison, ImportRow, ImportSummary, MergeOptions,
  PersonDetail, PersonInput, RegistryApi, ReportKind, SearchQuery, SearchResult, SessionUser,
} from './api'
import {
  DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, ageFrom, findDuplicates, scorePair,
  type DuplicateMatch, type PersonComparable,
} from './duplicateEngine'
import { fullName, identityKey, normalizeDate, normalizeText, trigramSimilarity } from './normalize'
import { uid, isToday, sha256Hex } from './utils'
import { verifyOfflineCredential } from './offlineCredential'
import {
  barangayOverview, dashboardStats, dataQuality, live, qualityRecords, ageGroupCounts, sexCounts, statusCounts,
} from './analytics'

import { idbAvailable, idbGet, idbSet } from './idb'

const STORAGE_KEY = 'nmbr.local.v1'
const PERSONS_IDB_KEY = 'persons'
const SESSION_KEY = 'nmbr.session.v1'
const SESSION_TIMEOUT_FALLBACK = 30
const SALT = 'nmbr-local-demo-salt'

/**
 * Whether the on-device registry starts life with the fictional demonstration
 * registry (12 barangays, 160 members, demo passwords).
 *
 * Development and test builds keep it so the system can be explored and the
 * suite has data to work with. Production builds start EMPTY: a published
 * municipal registry must not carry fictional residents or the published
 * demonstration passwords on office devices — real records arrive through the
 * mirror once a device signs in, and real accounts sign in offline through the
 * verifier kept by src/lib/offlineCredential.ts. Set VITE_DEMO_SEED=true to
 * build a training/demo bundle on purpose.
 */
export const DEMO_SEED_ENABLED =
  import.meta.env.DEV || (import.meta.env.VITE_DEMO_SEED as string | undefined) === 'true'

type ImportBatchRecord = {
  id: string
  file_name: string
  status: string
  created_at: string
  default_barangay_id: string | null
  rows: ImportRow[]
}

type LocalDB = {
  version: number
  seeded_at: string
  barangays: Barangay[]
  persons: Person[]
  households: Household[]
  history: Record<string, PersonDetail['history']>
  cases: DuplicateCase[]
  audit: AuditLogRow[]
  users: Array<ManagedUser & { password_hash: string }>
  settings: SystemSettings
  importBatches: ImportBatchRecord[]
  programs: SubsidyProgram[]
  beneficiaries: SubsidyBeneficiary[]
  outbox: OutboxItem[]
  lastSyncAt: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(9 + (days % 7), (days * 7) % 60, 0, 0)
  return d.toISOString()
}

export class LocalApi implements RegistryApi {
  readonly mode = 'local' as const
  readonly offlineCapable = true

  private db: LocalDB
  private current: SessionUser | null = null
  private lastActivity = Date.now()
  private listeners = new Set<() => void>()

  /** Resolves once the persons mirror has been read from IndexedDB. */
  readonly hydrated: Promise<void>
  /** True when the device store refused a write (quota / no IndexedDB). */
  storageLimited = false
  private personsTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.db = this.load()
    this.hydrated = this.hydrate()
    if (typeof window !== 'undefined') {
      const flush = () => { void this.flushPersons() }
      window.addEventListener('pagehide', flush)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush()
      })
    }
  }

  /**
   * Persons live in IndexedDB at municipal scale. On boot, take them from
   * there; a store written by an older build (persons still inside
   * localStorage) is migrated on first run.
   */
  private async hydrate(): Promise<void> {
    if (!idbAvailable()) return
    const stored = await idbGet<Person[]>(PERSONS_IDB_KEY)
    if (stored) {
      this.db.persons = stored
    } else if (this.db.persons.length) {
      await idbSet(PERSONS_IDB_KEY, this.db.persons)
      this.persist()
    }
  }

  /** Write the mirror through now (used before unload and in tests). */
  async flushPersons(): Promise<void> {
    if (this.personsTimer) { clearTimeout(this.personsTimer); this.personsTimer = null }
    if (!idbAvailable()) return
    const ok = await idbSet(PERSONS_IDB_KEY, this.db.persons)
    if (!ok) this.storageLimited = true
  }

  private schedulePersons(): void {
    if (!idbAvailable()) return
    if (this.personsTimer) clearTimeout(this.personsTimer)
    this.personsTimer = setTimeout(() => {
      this.personsTimer = null
      void this.flushPersons()
    }, 400)
  }

  // ------------------------------------------------------------------ storage
  private load(): LocalDB {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as LocalDB
        if (parsed.version === 1) return parsed
      }
    } catch {
      /* corrupted store — rebuild from the seed */
    }
    const fresh = this.buildSeed()
    this.persist(fresh)
    return fresh
  }

  private persist(db: LocalDB = this.db) {
    // localStorage keeps everything except the persons mirror, which lives
    // in IndexedDB (see idb.ts): at 40 000 members the mirror is ~16 MB and
    // would blow the ~5 MB origin quota while stalling every save.
    const small: LocalDB = idbAvailable() ? { ...db, persons: [] } : db
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(small))
    } catch (err) {
      this.storageLimited = true
      console.warn('NMBR: local store could not be persisted (quota?)', err)
    }
    if (db === this.db) this.schedulePersons()
    this.listeners.forEach((l) => l())
  }

  private buildSeed(): LocalDB {
    // Production builds start with an empty on-device registry: no fictional
    // residents, no demonstration passwords. Real records arrive through the
    // mirror after the first online sign-in.
    if (!DEMO_SEED_ENABLED) {
      return {
        version: 1,
        seeded_at: nowIso(),
        barangays: [],
        persons: [],
        households: [],
        history: {},
        cases: [],
        audit: [],
        users: [],
        settings: {
          weights: { ...DEFAULT_WEIGHTS },
          thresholds: { ...DEFAULT_THRESHOLDS },
          session_timeout_minutes: SESSION_TIMEOUT_FALLBACK,
          mask_contact_in_lists: true,
          block_on_very_likely: true,
          require_reason_on_edit: true,
          municipality: 'Nabua',
          province: 'Camarines Sur',
        },
        importBatches: [],
        programs: [],
        beneficiaries: [],
        outbox: [],
        lastSyncAt: null,
      }
    }
    const barangays: Barangay[] = seed.barangays.map((b, i) => ({
      id: `b${(i + 1).toString().padStart(3, '0')}`,
      name: b.name,
      municipality: 'Nabua',
      province: 'Camarines Sur',
      district: b.district,
      active: true,
      created_at: daysAgoIso(720),
      total_members: 0,
    }))
    const byName = new Map(barangays.map((b) => [b.name, b]))

    const households: Household[] = seed.households.map((h, i) => ({
      id: `h${(i + 1).toString().padStart(3, '0')}`,
      household_no: h.household_no,
      barangay_id: byName.get(h.barangay)?.id ?? barangays[0].id,
      barangay_name: h.barangay,
      address: null,
      purok: null,
      head_person_id: null,
      created_at: daysAgoIso(500),
    }))

    const persons: Person[] = seed.persons.map((p) => {
      const barangay = byName.get(p.barangay)
      const household = p.household_no ? households.find((h) => h.household_no === p.household_no) : undefined
      return {
        id: p.id,
        reference_no: p.reference_no,
        first_name: p.first_name,
        middle_name: p.middle_name,
        last_name: p.last_name,
        suffix: p.suffix,
        date_of_birth: p.date_of_birth,
        sex: (p.sex as Person['sex']) ?? null,
        civil_status: p.civil_status,
        contact_number: p.contact_number,
        address: p.address,
        purok: p.purok,
        barangay_id: barangay?.id ?? null,
        barangay_name: barangay?.name ?? null,
        status: p.status as PersonStatus,
        remarks: p.remarks ?? null,
        household_id: household?.id ?? null,
        household_name: household?.household_no ?? null,
        created_at: daysAgoIso(p.created_days_ago),
        updated_at: daysAgoIso(p.updated_days_ago),
        created_by_name: 'Pedro Reyes',
        updated_by_name: 'Pedro Reyes',
      }
    })

    const history: Record<string, PersonDetail['history']> = {}
    for (const p of persons) {
      if (!p.barangay_id) continue
      history[p.id] = [{
        id: uid('h'),
        barangay_id: p.barangay_id,
        barangay_name: p.barangay_name ?? '',
        effective_from: p.created_at.slice(0, 10),
        effective_to: null,
        status: 'ACTIVE',
        reason: null,
        notes: 'Initial registry entry',
        created_at: p.created_at,
        created_by_name: p.created_by_name ?? null,
      }]
    }

    // sample transfers: one master record, two residencies
    for (const t of seed.transfers) {
      const person = persons[t.personIndex]
      if (!person) continue
      const to = byName.get(t.to)
      const from = byName.get(t.from)
      if (!to || !from) continue
      const rows = history[person.id] ?? []
      rows[0] = {
        ...rows[0],
        barangay_id: from.id,
        barangay_name: from.name,
        effective_from: daysAgoIso(t.fromDays).slice(0, 10),
        effective_to: daysAgoIso(t.toDays).slice(0, 10),
        status: 'ENDED',
        reason: t.reason as PersonDetail['history'][number]['reason'],
        notes: t.notes,
      }
      rows.push({
        id: uid('h'),
        barangay_id: to.id,
        barangay_name: to.name,
        effective_from: daysAgoIso(t.toDays).slice(0, 10),
        effective_to: null,
        status: 'ACTIVE',
        reason: t.reason as PersonDetail['history'][number]['reason'],
        notes: t.notes,
        created_at: daysAgoIso(t.toDays),
        created_by_name: 'Maria Santos',
      })
      history[person.id] = rows
      person.barangay_id = to.id
      person.barangay_name = to.name
      person.status = person.status === 'ARCHIVED' ? person.status : person.status
    }

    const cases: DuplicateCase[] = seed.duplicate_cases.map((c) => ({
      id: uid('dc'),
      person_id_a: c.a,
      person_id_b: c.b,
      match_score: c.score,
      match_band: c.band,
      matching_fields: c.fields ?? [],
      status: c.status as DuplicateCase['status'],
      reviewed_by: null,
      reviewed_by_name: c.reviewed_by ?? null,
      reviewed_at: c.reviewed_days_ago != null ? daysAgoIso(c.reviewed_days_ago) : null,
      resolution: c.resolution ?? null,
      notes: c.notes ?? null,
      created_at: daysAgoIso(((c.reviewed_days_ago ?? 5) + 3)),
      source: c.source,
    }))

    const audit: AuditLogRow[] = [
      {
        id: 'a1', user_id: 'u1', user_name: 'Engr. Ramon Villaflor', action: 'IMPORTED',
        entity_type: 'IMPORT_BATCH', entity_id: null, entity_label: 'nmbr_initial_load.csv',
        old_values: null, new_values: { imported: persons.length }, reason: 'Initial municipal registry load',
        session_info: { app: 'NMBR' }, timestamp: daysAgoIso(30),
      },
      {
        id: 'a2', user_id: 'u2', user_name: 'Maria Santos', action: 'SETTINGS_UPDATED',
        entity_type: 'SETTINGS', entity_id: null, entity_label: 'Duplicate detection rules',
        old_values: { notice: 55 }, new_values: { notice: 60 }, reason: null,
        session_info: { app: 'NMBR' }, timestamp: daysAgoIso(12),
      },
    ]

    return {
      version: 1,
      seeded_at: nowIso(),
      barangays,
      persons,
      households,
      history,
      cases,
      audit,
      users: seed.users.map((u, i) => ({
        id: `u${i + 1}`,
        name: u.name,
        email: u.email,
        role: u.role as ManagedUser['role'],
        active: true,
        barangay_scope: null,
        created_at: daysAgoIso(700),
        last_login: daysAgoIso(i + 1),
        password_hash: u.password_hash ?? '',
      })),
      settings: {
        weights: { ...DEFAULT_WEIGHTS },
        thresholds: { ...DEFAULT_THRESHOLDS },
        session_timeout_minutes: SESSION_TIMEOUT_FALLBACK,
        mask_contact_in_lists: true,
        block_on_very_likely: true,
        require_reason_on_edit: true,
        municipality: 'Nabua',
        province: 'Camarines Sur',
      },
      importBatches: [],
        programs: [],
        beneficiaries: [],
      outbox: [],
      lastSyncAt: null,
    }
  }

  /** Password hashes are derived lazily so the seed file stays human readable. */
  private async ensureCredentials() {
    // seed.json carries salted hashes only — no usable password ships in the
    // bundle. Stores persisted by older builds are topped up from the same
    // hashes so an upgraded device keeps its demonstration logins.
    const hashes: Record<string, string> = {}
    for (const u of seed.users) hashes[u.email] = u.password_hash ?? ''
    let changed = false
    for (const user of this.db.users) {
      if (!user.password_hash) {
        user.password_hash = hashes[user.email] ?? await sha256Hex(`${SALT}:${user.email}:`)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  resetToSeed() {
    const fresh = this.buildSeed()
    this.db = fresh
    this.persist()
  }

  // ------------------------------------------------------------------ session
  async signIn(email: string, password: string): Promise<ApiResult<SessionUser>> {
    await this.ensureCredentials()
    const user = this.db.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase())
    if (!user) {
      // A real office account that this device already authenticated against
      // the municipal server may sign in again without a connection; the
      // verifier (never the password) was kept at that online sign-in.
      const cached = await verifyOfflineCredential(email, password)
      if (cached && cached.active) {
        this.current = cached
        this.lastActivity = Date.now()
        localStorage.setItem(SESSION_KEY, JSON.stringify({ user: cached, at: Date.now() }))
        this.audit('LOGIN', 'USERS', cached.id, cached.name, null,
          'Signed in to the on-device registry copy (offline re-sign-in)')
        this.persist()
        return { ok: true, data: cached }
      }
      return { ok: false, error: 'No office account matches that email address.', code: 'NO_ACCOUNT' }
    }
    if (!user.active) return { ok: false, error: 'This account has been deactivated.', code: 'INACTIVE' }
    const hash = await sha256Hex(`${SALT}:${user.email}:${password}`)
    if (hash !== user.password_hash) {
      return { ok: false, error: 'Incorrect password.', code: 'BAD_PASSWORD' }
    }
    user.last_login = nowIso()
    const session: SessionUser = {
      id: user.id, name: user.name, email: user.email, role: user.role, active: user.active,
      barangay_scope: user.barangay_scope, last_login: user.last_login,
    }
    this.current = session
    this.lastActivity = Date.now()
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user: session, at: Date.now() }))
    this.audit('LOGIN', 'USERS', user.id, user.name, null, 'Signed in (offline mode)')
    this.persist()
    return { ok: true, data: session }
  }

  async signOut(): Promise<void> {
    if (this.current) this.audit('LOGOUT', 'USERS', this.current.id, this.current.name, null, null)
    this.current = null
    localStorage.removeItem(SESSION_KEY)
    this.persist()
  }

  async restoreSession(): Promise<SessionUser | null> {
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { user: SessionUser; at: number }
      const timeoutMs = this.db.settings.session_timeout_minutes * 60_000
      if (Date.now() - parsed.at > timeoutMs) {
        localStorage.removeItem(SESSION_KEY)
        return null
      }
      const still = this.db.users.find((u) => u.id === parsed.user.id)
      if (still) {
        if (!still.active) return null
        this.current = { ...parsed.user, role: still.role, active: still.active }
      } else {
        // An account of the municipal server (production devices carry no
        // local user list): the cached profile was verified at sign-in.
        this.current = { ...parsed.user }
      }
      this.lastActivity = Date.now()
      return this.current
    } catch {
      return null
    }
  }

  touchSession(): void {
    this.lastActivity = Date.now()
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { user: SessionUser; at: number }
        parsed.at = Date.now()
        localStorage.setItem(SESSION_KEY, JSON.stringify(parsed))
      } catch {
        /* ignore */
      }
    }
  }

  sessionExpired(): boolean {
    return Date.now() - this.lastActivity > this.db.settings.session_timeout_minutes * 60_000
  }

  getSession(): SessionUser | null {
    return this.current
  }

  // ------------------------------------------------------------------ helpers
  private role(): string {
    return this.current?.role ?? 'VIEWER'
  }

  private require(roles: string[]): { ok: false; error: string; code?: string } | null {
    if (!this.current || !this.current.active) {
      return { ok: false, error: 'Your session has expired. Please sign in again.', code: 'UNAUTHENTICATED' }
    }
    if (!roles.includes(this.role())) {
      return {
        ok: false, code: 'FORBIDDEN',
        error: `Your role (${this.role()}) is not permitted to perform this action. Required: ${roles.join(' or ')}.`,
      }
    }
    return null
  }

  private audit(
    action: string, entityType: string, entityId: string | null, label: string | null,
    newValues: unknown, reason: string | null, oldValues: unknown = null,
  ) {
    this.db.audit.unshift({
      id: uid('a'),
      user_id: this.current?.id ?? null,
      user_name: this.current?.name ?? 'System',
      action,
      entity_type: entityType,
      entity_id: entityId,
      entity_label: label,
      old_values: (oldValues as Record<string, unknown>) ?? null,
      new_values: (newValues as Record<string, unknown>) ?? null,
      reason,
      session_info: { app: 'NMBR', mode: 'offline', at: nowIso() },
      timestamp: nowIso(),
    } as AuditLogRow)
    if (this.db.audit.length > 5000) this.db.audit.length = 5000
  }

  private toComparable(p: Person): PersonComparable {
    return {
      id: p.id, first_name: p.first_name, middle_name: p.middle_name, last_name: p.last_name,
      suffix: p.suffix, date_of_birth: p.date_of_birth, sex: p.sex, purok: p.purok, address: p.address,
      contact_number: p.contact_number, barangay_id: p.barangay_id, barangay_name: p.barangay_name ?? null,
      status: p.status,
    }
  }

  private pool(): Person[] {
    return this.db.persons.filter(live)
  }

  private thresholds() {
    return { ...DEFAULT_THRESHOLDS, ...this.db.settings.thresholds } as typeof DEFAULT_THRESHOLDS
  }

  private weights() {
    return { ...DEFAULT_WEIGHTS, ...this.db.settings.weights } as typeof DEFAULT_WEIGHTS
  }

  private person(id: string): Person | undefined {
    return this.db.persons.find((p) => p.id === id)
  }

  private decorate(p: Person): Person {
    const barangay = this.db.barangays.find((b) => b.id === p.barangay_id)
    const household = this.db.households.find((h) => h.id === p.household_id)
    return {
      ...p,
      barangay_name: barangay?.name ?? null,
      household_name: household?.household_no ?? null,
      open_duplicates: this.db.cases.filter(
        (c) => c.status === 'PENDING' && (c.person_id_a === p.id || c.person_id_b === p.id),
      ).length,
    }
  }

  // ------------------------------------------------------------------ reference
  async listBarangays(includeInactive = false): Promise<Barangay[]> {
    const list = this.db.barangays.filter((b) => includeInactive || b.active)
    const overview = barangayOverview(this.decorateAll(), list, this.db.cases)
    return overview.sort((a, b) => a.name.localeCompare(b.name))
  }

  private decorateAll(): Person[] {
    return this.db.persons.map((p) => this.decorate(p))
  }

  async upsertBarangay(input: Partial<Barangay> & { name: string }): Promise<ApiResult<Barangay>> {
    const denial = this.require(['SYSTEM_ADMIN', 'ADMINISTRATOR'])
    if (denial) return denial
    if (!input.name?.trim()) return { ok: false, error: 'Barangay name is required.' }
    const existing = input.id ? this.db.barangays.find((b) => b.id === input.id) : undefined
    if (existing) {
      const before = { ...existing }
      Object.assign(existing, {
        name: input.name.trim(),
        district: input.district ?? existing.district,
        active: input.active ?? existing.active,
        municipality: input.municipality ?? existing.municipality,
        province: input.province ?? existing.province,
      })
      this.audit('BARANGAY_UPDATED', 'BARANGAYS', existing.id, existing.name, existing, null, before)
      this.persist()
      return { ok: true, data: existing }
    }
    const brgy: Barangay = {
      id: uid('b'),
      name: input.name.trim(),
      municipality: input.municipality ?? 'Nabua',
      province: input.province ?? 'Camarines Sur',
      district: input.district ?? null,
      active: input.active ?? true,
      created_at: nowIso(),
    }
    this.db.barangays.push(brgy)
    this.audit('BARANGAY_CREATED', 'BARANGAYS', brgy.id, brgy.name, brgy, null)
    this.persist()
    return { ok: true, data: brgy }
  }

  async getSettings(): Promise<SystemSettings> {
    return this.db.settings
  }

  async saveSettings(patch: { weights?: unknown; thresholds?: unknown; system?: unknown }): Promise<ApiResult<SystemSettings>> {
    const denial = this.require(['SYSTEM_ADMIN'])
    if (denial) return denial
    const before = JSON.parse(JSON.stringify(this.db.settings)) as SystemSettings
    if (patch.weights) this.db.settings.weights = { ...this.db.settings.weights, ...(patch.weights as object) }
    if (patch.thresholds) {
      const t = { ...this.db.settings.thresholds, ...(patch.thresholds as object) } as Record<string, number>
      if (!(t.block > t.warn && t.warn > t.notice)) {
        return { ok: false, error: 'Thresholds must decrease: block > warn > notice.' }
      }
      this.db.settings.thresholds = t
    }
    if (patch.system) this.db.settings = { ...this.db.settings, ...(patch.system as object) }
    this.db.settings.updated_at = nowIso()
    this.audit('SETTINGS_UPDATED', 'SETTINGS', null, 'Duplicate detection rules', this.db.settings, null, before)
    this.persist()
    return { ok: true, data: this.db.settings }
  }

  // ------------------------------------------------------------------ reads
  async dashboardStats(): Promise<DashboardStats> {
    const base = dashboardStats(this.decorateAll(), this.db.barangays, this.db.cases, this.db.audit)
    const year = new Date().getFullYear()
    const transferred = Object.values(this.db.history).filter((history) =>
      history.length > 1 && history.some((h) => new Date(h.effective_from).getFullYear() === year),
    ).length
    return {
      ...base,
      transferred_this_year: transferred,
      merged_records: this.db.persons.filter((p) => !!p.merged_into).length,
    }
  }

  async searchPersons(query: SearchQuery): Promise<SearchResult> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
    const offset = Math.max(query.offset ?? 0, 0)
    const q = (query.query ?? '').trim()
    const pending = this.db.cases.filter((c) => c.status === 'PENDING')
    let rows = this.decorateAll()

    if (query.barangay_id) rows = rows.filter((p) => p.barangay_id === query.barangay_id)
    if (!query.status) rows = rows.filter((p) => p.status !== 'ARCHIVED')
    else rows = rows.filter((p) => p.status === query.status)
    if (query.sex) rows = rows.filter((p) => p.sex === query.sex)
    if (query.purok) rows = rows.filter((p) => normalizeText(p.purok) === normalizeText(query.purok))
    if (query.created_since) {
      rows = rows.filter((p) => (p.created_at ?? '').slice(0, 10) >= query.created_since!)
    }
    if (query.duplicates_only) {
      rows = rows.filter((p) => pending.some((c) => c.person_id_a === p.id || c.person_id_b === p.id))
    }
    if (query.for_review_only) rows = rows.filter((p) => p.status === 'FOR_REVIEW')
    if (query.attention_only || query.attention) {
      rows = rows.filter((p) => {
        switch (query.attention) {
          case 'missing_birthdate': return !p.date_of_birth
          case 'missing_sex': return !p.sex
          case 'missing_barangay': return !p.barangay_id
          case 'invalid_contact': return !!p.contact_number && p.contact_number.replace(/\D/g, '').length < 7
          case 'incomplete_address': return !p.address || !p.purok
          default:
            return p.status === 'FOR_REVIEW' || !p.date_of_birth || !p.sex || !p.barangay_id || !p.address ||
              pending.some((c) => c.person_id_a === p.id || c.person_id_b === p.id)
        }
      })
    }

    if (q) {
      const qn = normalizeText(q)
      const qd = q.replace(/\D/g, '')
      const qdate = normalizeDate(q)
      rows = rows
        .map((p) => {
          const name = normalizeText(`${p.first_name} ${p.middle_name ?? ''} ${p.last_name} ${p.suffix ?? ''}`)
          let score = 0
          if (name.includes(qn)) score = 100
          else {
            const sim = trigramSimilarity(name, qn)
            if (sim >= 0.45) score = sim * 90
          }
          if (p.reference_no.toLowerCase().includes(q.toLowerCase())) score = Math.max(score, 95)
          if (qd.length >= 6 && (p.contact_number ?? '').replace(/\D/g, '').endsWith(qd)) score = Math.max(score, 95)
          if (qdate && p.date_of_birth === qdate) score = Math.max(score, 95)
          if (normalizeText(p.barangay_name).includes(qn)) score = Math.max(score, 80)
          if (normalizeText(p.purok).includes(qn)) score = Math.max(score, 70)
          return { p, score }
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.p.last_name.localeCompare(b.p.last_name))
        .map((r) => r.p)
    } else {
      const dir = query.dir === 'desc' ? -1 : 1
      rows = rows.sort((a, b) => {
        switch (query.sort) {
          case 'updated': return (a.updated_at < b.updated_at ? 1 : -1) * dir
          case 'barangay': return (a.barangay_name ?? '').localeCompare(b.barangay_name ?? '') * dir
          case 'dob': return ((a.date_of_birth ?? '9999') < (b.date_of_birth ?? '9999') ? -1 : 1) * dir
          default: return a.last_name.localeCompare(b.last_name) * dir || a.first_name.localeCompare(b.first_name) * dir
        }
      })
    }

    return { total: rows.length, rows: rows.slice(offset, offset + limit) }
  }

  async personIndex(): Promise<PersonIndexRow[]> {
    return this.pool().map((p) => ({
      id: p.id, reference_no: p.reference_no, first_name: p.first_name, middle_name: p.middle_name,
      last_name: p.last_name, suffix: p.suffix, date_of_birth: p.date_of_birth, sex: p.sex,
      purok: p.purok, address: p.address, contact_number: p.contact_number, barangay_id: p.barangay_id,
      barangay_name: p.barangay_name ?? null, status: p.status, updated_at: p.updated_at,
    }))
  }

  async getPerson(id: string): Promise<PersonDetail | null> {
    const person = this.person(id)
    if (!person) return null
    const decorated = this.decorate(person)
    return {
      ...decorated,
      history: (this.db.history[id] ?? []).slice().sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)),
      household: this.db.households.find((h) => h.id === person.household_id) ?? null,
      duplicates: this.db.cases
        .filter((c) => c.person_id_a === id || c.person_id_b === id)
        .sort((a, b) => b.match_score - a.match_score)
        .map((c) => {
          const otherId = c.person_id_a === id ? c.person_id_b : c.person_id_a
          const other = this.person(otherId)
          return {
            id: c.id, status: c.status, match_score: c.match_score, match_band: c.match_band,
            matching_fields: c.matching_fields, matched_details: c.matched_details,
            created_at: c.created_at, resolution: c.resolution, notes: c.notes,
            reviewed_by_name: c.reviewed_by_name, reviewed_at: c.reviewed_at,
            other_person: other ? this.toIndex(other) : ({} as PersonIndexRow),
          }
        }),
      audit: this.db.audit.filter((a) => a.entity_id === id || a.entity_label === fullName(person)).slice(0, 100),
      merged_from: this.db.persons.filter((p) => p.merged_into === id).map((p) => this.toIndex(p)),
    }
  }

  private toIndex(p: Person): PersonIndexRow {
    return {
      id: p.id, reference_no: p.reference_no, first_name: p.first_name, middle_name: p.middle_name,
      last_name: p.last_name, suffix: p.suffix, date_of_birth: p.date_of_birth, sex: p.sex,
      purok: p.purok, address: p.address, contact_number: p.contact_number,
      barangay_id: p.barangay_id, barangay_name: p.barangay_name ?? null,
      status: p.status, updated_at: p.updated_at,
    }
  }

  async checkDuplicates(candidate: PersonComparable, excludeId?: string | null): Promise<DuplicateMatch[]> {
    const pool = this.pool().filter((p) => p.id !== excludeId)
    return findDuplicates(candidate, pool.map((p) => this.toComparable(p)), {
      weights: this.weights(), thresholds: this.thresholds(), excludeId: excludeId ?? undefined, limit: 10,
    })
  }

  async bulkCheckDuplicates(rows: PersonInput[]): Promise<Array<{ index: number; matches: DuplicateMatch[] }>> {
    const pool = this.pool().map((p) => this.toComparable(p))
    return rows.map((row, index) => {
      const candidate: PersonComparable = {
        id: `row-${index}`, first_name: row.first_name, middle_name: row.middle_name ?? null,
        last_name: row.last_name, suffix: row.suffix ?? null, date_of_birth: row.date_of_birth ?? null,
        sex: row.sex ?? null, purok: row.purok ?? null, address: row.address ?? null,
        contact_number: row.contact_number ?? null, barangay_id: row.barangay_id ?? null,
        barangay_name: this.db.barangays.find((b) => b.id === row.barangay_id)?.name ?? null,
      }
      return {
        index,
        matches: findDuplicates(candidate, pool, {
          weights: this.weights(), thresholds: this.thresholds(), limit: 3,
        }),
      }
    })
  }

  async dataQuality(): Promise<DataQualityRow[]> {
    return dataQuality(this.decorateAll(), this.db.cases)
  }

  async qualityRecords(metric: string, limit = 100): Promise<unknown[]> {
    return qualityRecords(metric, this.decorateAll(), limit)
  }

  async reports(kind: ReportKind, params?: { from?: string; to?: string; barangay_id?: string }): Promise<unknown> {
    const persons = this.decorateAll()
    const from = params?.from ? new Date(params.from) : new Date(new Date().getFullYear(), 0, 1)
    const to = params?.to ? new Date(params.to) : new Date()
    const inRange = (iso?: string | null) => {
      if (!iso) return false
      const d = new Date(iso)
      return d >= from && d <= to
    }
    const scoped = params?.barangay_id ? persons.filter((p) => p.barangay_id === params.barangay_id) : persons

    switch (kind) {
      case 'by_barangay':
        return (await this.listBarangays(true)).map((b) => {
          const members = scoped.filter((p) => p.barangay_id === b.id && live(p))
          return {
            barangay: b.name,
            total: members.length,
            active: members.filter((p) => p.status === 'ACTIVE').length,
            inactive: members.filter((p) => p.status === 'INACTIVE').length,
            for_review: members.filter((p) => p.status === 'FOR_REVIEW').length,
            new_in_period: members.filter((p) => inRange(p.created_at)).length,
            male: members.filter((p) => p.sex === 'MALE').length,
            female: members.filter((p) => p.sex === 'FEMALE').length,
            duplicates: this.db.cases.filter((c) => {
              if (c.status !== 'PENDING') return false
              const recA = this.person(c.person_id_a)
              const recB = this.person(c.person_id_b)
              return recA?.barangay_id === b.id || recB?.barangay_id === b.id
            }).length,
          }
        })
      case 'by_sex':
        return sexCounts(scoped)
      case 'by_age_group':
        return ageGroupCounts(scoped)
      case 'new_members':
        return scoped.filter((p) => inRange(p.created_at)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((p) => this.toIndex(p))
      case 'transferred': {
        const rows: Array<Record<string, unknown>> = []
        for (const [personId, history] of Object.entries(this.db.history)) {
          if (history.length < 2) continue
          const person = this.person(personId)
          if (!person) continue
          for (const h of history) {
            if (!inRange(h.effective_from)) continue
            rows.push({
              person: this.toIndex(person), barangay: h.barangay_name, effective_from: h.effective_from,
              effective_to: h.effective_to, reason: h.reason, notes: h.notes, recorded_at: h.created_at,
              recorded_by: h.created_by_name,
            })
          }
        }
        return rows.sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))
      }
      case 'possible_duplicates':
        return this.db.cases.filter((c) => c.status === 'PENDING').map((c) => ({
          case_id: c.id, score: c.match_score, band: c.match_band, status: c.status,
          fields: c.matching_fields, created_at: c.created_at,
          person_a: this.toIndex(this.person(c.person_id_a) as Person),
          person_b: this.toIndex(this.person(c.person_id_b) as Person),
        }))
      case 'resolved_duplicates':
        return this.db.cases.filter((c) => c.status !== 'PENDING').map((c) => ({
          case_id: c.id, score: c.match_score, status: c.status, resolution: c.resolution,
          notes: c.notes, reviewed_by: c.reviewed_by_name, reviewed_at: c.reviewed_at,
          person_a: this.toIndex(this.person(c.person_id_a) as Person),
          person_b: this.toIndex(this.person(c.person_id_b) as Person),
        }))
      case 'data_quality':
        return this.dataQuality()
      case 'encoder_activity': {
        const map = new Map<string, Record<string, number>>()
        for (const a of this.db.audit) {
          if (!inRange(a.timestamp)) continue
          const key = a.user_name ?? 'Unknown'
          const row = map.get(key) ?? { created: 0, updated: 0, transferred: 0, merged: 0, duplicate_reviews: 0, imported: 0, total: 0 }
          if (a.action === 'CREATED') row.created++
          if (a.action === 'UPDATED') row.updated++
          if (a.action === 'TRANSFERRED') row.transferred++
          if (a.action === 'MERGED') row.merged++
          if (a.action === 'DUPLICATE_REVIEWED') row.duplicate_reviews++
          if (a.action === 'IMPORTED') row.imported++
          row.total++
          map.set(key, row)
        }
        const activity: Array<Record<string, number | string>> = [...map.entries()].map(([user, v]) => ({ user, ...v }))
        return activity.sort((a, b) => Number(b.total) - Number(a.total))
      }
      case 'audit_summary': {
        const map = new Map<string, number>()
        for (const a of this.db.audit) {
          if (!inRange(a.timestamp)) continue
          map.set(a.action, (map.get(a.action) ?? 0) + 1)
        }
        return [...map.entries()].map(([action, total]) => ({ action, total })).sort((a, b) => b.total - a.total)
      }
      default:
        return []
    }
  }

  // ------------------------------------------------------------------ writes
  async createPerson(
    input: PersonInput & { client_ref?: string },
    opts?: { confirmedDistinct?: boolean; reason?: string },
  ): Promise<CreatePersonResult> {
    const denial = this.require(['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return { ok: false, code: denial.code, error: denial.error }
    if (!input.first_name?.trim() || !input.last_name?.trim()) {
      return { ok: false, code: 'VALIDATION', error: 'First name and last name are required.' }
    }
    if (input.date_of_birth && !normalizeDate(input.date_of_birth)) {
      return { ok: false, code: 'VALIDATION', error: 'Date of birth is not a valid date.' }
    }

    const barangay = this.db.barangays.find((b) => b.id === input.barangay_id)
    const candidate: PersonComparable = {
      id: 'new', first_name: input.first_name, middle_name: input.middle_name ?? null,
      last_name: input.last_name, suffix: input.suffix ?? null,
      date_of_birth: normalizeDate(input.date_of_birth) || null, sex: input.sex ?? null,
      purok: input.purok ?? null, address: input.address ?? null,
      contact_number: input.contact_number ?? null, barangay_id: input.barangay_id ?? null,
      barangay_name: barangay?.name ?? null,
    }

    const matches = await this.checkDuplicates(candidate)
    const band = matches[0]?.score.band ?? 'DISTINCT'

    if (!opts?.confirmedDistinct && band === 'VERY_LIKELY' && this.db.settings.block_on_very_likely) {
      return {
        ok: false, code: 'DUPLICATE_REVIEW_REQUIRED', band, matches,
        error: 'Very likely duplicate. Review the existing record before continuing.',
      }
    }

    // deterministic identity guard (mirrors the database unique index)
    const key = identityKey(candidate)
    const collide = this.pool().find((p) => identityKey(this.toComparable(p)) === key)
    if (collide && !opts?.confirmedDistinct) {
      return {
        ok: false, code: 'DUPLICATE_REVIEW_REQUIRED', band: 'VERY_LIKELY',
        matches: (await this.checkDuplicates(candidate)).slice(0, 1),
        error: 'An existing master record already matches this identity.',
      }
    }

    const status: PersonStatus = collide || opts?.confirmedDistinct ? 'FOR_REVIEW' : 'ACTIVE'
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : uid('p')
    // Paper-list family grouping (LP-TOPAS): resolve or create the household
    // on the device exactly like fn_create_person does on the server.
    let householdId: string | null = null
    const hhNo = input.household_no?.trim()
    if (hhNo) {
      let hh = this.db.households.find((h) => h.household_no === hhNo)
      if (!hh && input.barangay_id) {
        hh = {
          id: uid('hh'), household_no: hhNo, barangay_id: input.barangay_id,
          barangay_name: this.db.barangays.find((b) => b.id === input.barangay_id)?.name ?? '',
          address: null, purok: null, head_person_id: null, created_at: nowIso(),
        }
        this.db.households.push(hh)
      }
      householdId = hh?.id ?? null
    }

    const person: Person = {
      id,
      reference_no: `NMBR-${(2600 + this.db.persons.length).toString().padStart(6, '0')}`,
      first_name: input.first_name.trim(),
      middle_name: input.middle_name?.trim() || null,
      last_name: input.last_name.trim(),
      suffix: input.suffix?.trim() || null,
      date_of_birth: normalizeDate(input.date_of_birth) || null,
      sex: (input.sex as Person['sex']) ?? null,
      civil_status: input.civil_status ?? null,
      contact_number: input.contact_number?.trim() || null,
      address: input.address?.trim() || null,
      purok: input.purok?.trim() || null,
      barangay_id: input.barangay_id ?? null,
      status,
      remarks: collide ? 'Verified as a different person with identical details — queued for supervisor review.'
        : input.remarks ?? null,
      classification_code: input.classification_code ?? null,
      tags: input.tags?.filter((t) => t.trim()) ?? [],
      occupation: input.occupation?.trim() || null,
      household_id: householdId,
      created_at: nowIso(),
      updated_at: nowIso(),
      created_by: this.current?.id ?? null,
      created_by_name: this.current?.name ?? null,
      updated_by_name: this.current?.name ?? null,
    }
    this.db.persons.push(person)

    if (person.barangay_id) {
      this.db.history[person.id] = [{
        id: uid('h'), barangay_id: person.barangay_id, barangay_name: barangay?.name ?? '',
        effective_from: person.created_at.slice(0, 10), effective_to: null, status: 'ACTIVE',
        reason: null, notes: 'Initial registry entry', created_at: person.created_at,
        created_by_name: this.current?.name ?? null,
      }]
    }

    this.audit('CREATED', 'PERSONS', person.id, fullName(person), person, opts?.reason ?? null)

    // queue the near matches and the verified namesake for review
    if (collide || band === 'POSSIBLE' || (opts?.confirmedDistinct && band === 'VERY_LIKELY')) {
      for (const m of matches.slice(0, 3)) {
        if (collide || m.score.score >= this.thresholds().warn) {
          this.openCaseInternal(m.person.id, person.id, m.score.score, m.score.band, m.score.matchedFields, {
            reason: collide ? 'Identity key collision accepted as a different person' : undefined,
          }, opts?.reason)
        }
      }
    }

    this.persist()
    return { ok: true, person: this.decorate(person), band, matches }
  }

  private openCaseInternal(
    a: string, b: string, score: number, band: string, fields: string[],
    details?: Record<string, unknown>, notes?: string | null,
  ): DuplicateCase {
    const existing = this.db.cases.find(
      (c) => (c.person_id_a === a && c.person_id_b === b) || (c.person_id_a === b && c.person_id_b === a),
    )
    if (existing) {
      if (existing.status !== 'PENDING') {
        existing.status = 'PENDING'
        existing.notes = notes ?? existing.notes
      }
      return existing
    }
    const created: DuplicateCase = {
      id: uid('dc'),
      person_id_a: a,
      person_id_b: b,
      match_score: score,
      match_band: band,
      matching_fields: fields,
      matched_details: details ?? null,
      status: 'PENDING',
      reviewed_by: null,
      reviewed_by_name: null,
      reviewed_at: null,
      resolution: null,
      notes: notes ?? null,
      created_at: nowIso(),
      source: 'LIVE_CHECK',
    }
    this.db.cases.push(created)
    return created
  }

  async updatePerson(id: string, patch: Partial<PersonInput>, reason?: string): Promise<ApiResult<Person>> {
    const denial = this.require(['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const person = this.person(id)
    if (!person) return { ok: false, error: 'Member record not found.', code: 'NOT_FOUND' }
    if (person.merged_into) {
      return { ok: false, code: 'MERGED', error: 'This record was merged into another master record and is read-only.' }
    }
    if (this.role() === 'ENCODER') {
      const blocked = ['first_name', 'middle_name', 'last_name', 'suffix', 'date_of_birth'].find(
        (f) => patch[f as keyof PersonInput] !== undefined &&
          String(patch[f as keyof PersonInput] ?? '') !== String((person as unknown as Record<string, unknown>)[f] ?? ''),
      )
      if (blocked) {
        return {
          ok: false, code: 'FORBIDDEN_FIELD',
          error: `Encoders cannot change ${blocked.replace('_', ' ')}. Ask an administrator to correct identity fields.`,
        }
      }
    }
    if (this.db.settings.require_reason_on_edit && !reason &&
      (patch.date_of_birth !== undefined || patch.last_name !== undefined || patch.first_name !== undefined)) {
      return { ok: false, code: 'REASON_REQUIRED', error: 'A reason is required when changing identity fields.' }
    }

    const before = { ...person }
    const merged: Person = { ...person }
    for (const key of ['first_name', 'middle_name', 'last_name', 'suffix', 'civil_status', 'contact_number',
      'address', 'purok', 'remarks', 'sex', 'status'] as const) {
      const value = patch[key as keyof PersonInput]
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = (value as string)?.trim?.() || null
    }
    if (patch.date_of_birth !== undefined) merged.date_of_birth = normalizeDate(patch.date_of_birth) || null
    if (patch.classification_code !== undefined) merged.classification_code = patch.classification_code || null
    if (patch.tags !== undefined) merged.tags = (patch.tags ?? []).filter((t) => t.trim())
    if (patch.occupation !== undefined) merged.occupation = patch.occupation?.trim() || null
    merged.updated_at = nowIso()
    merged.updated_by_name = this.current?.name ?? null

    // proposal must not become a duplicate of another master record
    const candidate = this.toComparable(merged)
    const matches = await this.checkDuplicates(candidate, id)
    if (matches[0]?.score.band === 'VERY_LIKELY' && this.role() === 'ENCODER') {
      return {
        ok: false, code: 'DUPLICATE_REVIEW_REQUIRED', error:
          'These changes would make the record a very likely duplicate of another member. Submit it for review instead.',
      }
    }

    Object.assign(person, merged)
    this.audit('UPDATED', 'PERSONS', id, fullName(person), person, reason ?? null, before)
    if (matches[0] && matches[0].score.score >= this.thresholds().warn) {
      this.openCaseInternal(matches[0].person.id, id, matches[0].score.score, matches[0].score.band,
        matches[0].score.matchedFields, undefined, 'Raised automatically after an edit.')
    }
    this.persist()
    return { ok: true, data: this.decorate(person) }
  }

  async transferBarangay(input: {
    person_id: string; barangay_id: string; reason: string; effective_date?: string; notes?: string
  }): Promise<ApiResult<{ message: string }>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const person = this.person(input.person_id)
    if (!person) return { ok: false, error: 'Member record not found.', code: 'NOT_FOUND' }
    if (person.merged_into) return { ok: false, error: 'This record was merged and is read-only.', code: 'MERGED' }
    const barangay = this.db.barangays.find((b) => b.id === input.barangay_id)
    if (!barangay) return { ok: false, error: 'Barangay not found.', code: 'VALIDATION' }
    if (person.barangay_id === input.barangay_id) {
      return { ok: false, error: `The member is already assigned to ${barangay.name}.`, code: 'NO_CHANGE' }
    }
    const effective = input.effective_date || new Date().toISOString().slice(0, 10)
    const rows = this.db.history[input.person_id] ?? []
    const openRow = rows.find((h) => !h.effective_to)
    const previousName = person.barangay_name
    if (openRow) {
      openRow.effective_to = effective
      openRow.status = 'ENDED'
      openRow.notes = [openRow.notes, `Closed automatically on transfer to ${barangay.name}`].filter(Boolean).join(' | ')
    }
    rows.push({
      id: uid('h'), barangay_id: barangay.id, barangay_name: barangay.name,
      effective_from: effective, effective_to: null, status: 'ACTIVE',
      reason: input.reason as PersonDetail['history'][number]['reason'], notes: input.notes ?? null,
      created_at: nowIso(), created_by_name: this.current?.name ?? null,
    })
    this.db.history[input.person_id] = rows

    const before = { ...person }
    person.barangay_id = barangay.id
    person.barangay_name = barangay.name
    person.updated_at = nowIso()
    person.updated_by_name = this.current?.name ?? null

    this.audit('TRANSFERRED', 'PERSONS', person.id, fullName(person),
      { barangay_id: barangay.id, barangay_name: barangay.name, effective_from: effective },
      input.notes || `Barangay transfer: ${previousName} → ${barangay.name} (${input.reason})`,
      { barangay_id: before.barangay_id, barangay_name: previousName })
    this.persist()
    return { ok: true, data: { message: `Transferred to ${barangay.name}. One master record retained with full barangay history.` } }
  }

  async setPersonStatus(id: string, status: string, reason: string): Promise<ApiResult<Person>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const person = this.person(id)
    if (!person) return { ok: false, error: 'Member record not found.', code: 'NOT_FOUND' }
    if (status === 'ARCHIVED' && !reason?.trim()) {
      return { ok: false, code: 'REASON_REQUIRED', error: 'A reason is required to archive a member record.' }
    }
    const before = { ...person }
    if (person.status === 'ARCHIVED' && status !== 'ARCHIVED') {
      const key = identityKey(this.toComparable({ ...person, status: status as PersonStatus }))
      const collide = this.pool().filter((p) => p.id !== id).find((p) => identityKey(this.toComparable(p)) === key)
      if (collide) {
        return {
          ok: false, code: 'DUPLICATE_REVIEW_REQUIRED',
          error: `Restoring would duplicate the live record ${collide.reference_no}. Resolve the duplicate first.`,
        }
      }
      person.merged_into = null
    }
    person.status = status as PersonStatus
    if (status === 'ARCHIVED') person.archived_at = nowIso()
    person.updated_at = nowIso()
    person.updated_by_name = this.current?.name ?? null
    this.audit(
      status === 'ARCHIVED' ? 'ARCHIVED' : before.status === 'ARCHIVED' ? 'RESTORED' : 'STATUS_CHANGED',
      'PERSONS', id, fullName(person), { status }, reason ?? null, { status: before.status },
    )
    this.persist()
    return { ok: true, data: this.decorate(person) }
  }

  // ------------------------------------------------------------------ duplicates
  async listDuplicateCases(filters?: {
    status?: string; barangay_id?: string | null; min_score?: number | null
    query?: string; limit?: number; offset?: number
  }): Promise<{ total: number; rows: DuplicateCase[] }> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 200)
    const offset = Math.max(filters?.offset ?? 0, 0)
    const q = (filters?.query ?? '').toLowerCase()
    let rows = this.db.cases.slice()
    if (filters?.status && filters.status !== 'ALL') {
      rows = rows.filter((c) => c.status === filters.status)
    }
    if (filters?.min_score != null) rows = rows.filter((c) => c.match_score >= (filters.min_score as number))
    if (filters?.barangay_id) {
      rows = rows.filter((c) => {
        const a = this.person(c.person_id_a)
        const b = this.person(c.person_id_b)
        return a?.barangay_id === filters.barangay_id || b?.barangay_id === filters.barangay_id
      })
    }
    if (q) {
      rows = rows.filter((c) => {
        const a = this.person(c.person_id_a)
        const b = this.person(c.person_id_b)
        return [a, b].some((p) => p && (fullName(p).toLowerCase().includes(q) || p.reference_no.toLowerCase().includes(q)))
      })
    }
    rows.sort((a, b) => {
      if (a.status === 'PENDING' && b.status !== 'PENDING') return -1
      if (b.status === 'PENDING' && a.status !== 'PENDING') return 1
      return b.match_score - a.match_score || (a.created_at < b.created_at ? 1 : -1)
    })
    return {
      total: rows.length,
      rows: rows.slice(offset, offset + limit).map((c) => ({
        ...c,
        person_a: this.person(c.person_id_a) ? this.toIndex(this.decorate(this.person(c.person_id_a) as Person)) : undefined,
        person_b: this.person(c.person_id_b) ? this.toIndex(this.decorate(this.person(c.person_id_b) as Person)) : undefined,
      })),
    }
  }

  async comparePersons(a: string, b: string): Promise<DuplicateComparison | null> {
    const pa = this.person(a)
    const pb = this.person(b)
    if (!pa || !pb) return null
    const score = scorePair(this.toComparable(pb), this.toComparable(pa), {
      weights: this.weights(), thresholds: this.thresholds(),
    })
    const fields: Array<[keyof Person, string]> = [
      ['first_name', 'First name'], ['middle_name', 'Middle name'], ['last_name', 'Last name'],
      ['suffix', 'Suffix'], ['date_of_birth', 'Date of birth'], ['sex', 'Sex'],
      ['civil_status', 'Civil status'], ['contact_number', 'Contact number'], ['purok', 'Purok / Sitio'],
      ['address', 'Address'], ['barangay_name', 'Barangay'], ['status', 'Status'],
    ]
    return {
      score: score.score,
      band: score.band,
      reasons: score.reasons,
      flags: score.flags as unknown as Record<string, unknown>,
      a: this.decorate(pa),
      b: this.decorate(pb),
      diff: fields.map(([field, label]) => {
        const va = field === 'barangay_name' ? pa.barangay_name : (pa[field] as unknown)
        const vb = field === 'barangay_name' ? pb.barangay_name : (pb[field] as unknown)
        return {
          field: String(field), label, a: va ?? null, b: vb ?? null,
          same: normalizeText(String(va ?? '')) === normalizeText(String(vb ?? '')) || (!va && !vb),
        }
      }),
    }
  }

  async openDuplicateCase(a: string, b: string, source = 'MANUAL', notes?: string): Promise<ApiResult<{ case_id: string }>> {
    const denial = this.require(['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    if (a === b) return { ok: false, error: 'A record cannot be compared with itself.' }
    const pa = this.person(a)
    const pb = this.person(b)
    if (!pa || !pb) return { ok: false, error: 'One of the records no longer exists.' }
    const score = scorePair(this.toComparable(pb), this.toComparable(pa), {
      weights: this.weights(), thresholds: this.thresholds(),
    })
    const created = this.openCaseInternal(a, b, score.score, score.band, score.matchedFields, score as unknown as Record<string, unknown>, notes)
    this.audit('DUPLICATE_FLAGGED', 'DUPLICATE_CASE', created.id,
      `${fullName(pa)} vs ${fullName(pb)}`, score, notes ?? null)
    this.persist()
    return { ok: true, data: { case_id: created.id } }
  }

  async resolveDuplicateCase(caseId: string, resolution: string, notes: string): Promise<ApiResult<{ status: string }>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const row = this.db.cases.find((c) => c.id === caseId)
    if (!row) return { ok: false, error: 'Duplicate case not found.', code: 'NOT_FOUND' }
    if (!notes?.trim()) {
      return { ok: false, code: 'REASON_REQUIRED', error: 'Please record why this resolution was chosen — it becomes part of the audit trail.' }
    }
    const map: Record<string, DuplicateCase['status']> = {
      DIFFERENT_PERSON: 'DIFFERENT_PERSON', KEEP_BOTH: 'KEPT_BOTH', DEFER: 'DEFERRED',
      DISMISS: 'DISMISSED', MERGED: 'MERGED',
    }
    const status = map[resolution?.toUpperCase()]
    if (!status) return { ok: false, error: 'Resolution must be DIFFERENT_PERSON, KEEP_BOTH, DEFER or DISMISS.' }
    const before = { ...row }
    row.status = status
    row.resolution = resolution
    row.notes = notes
    row.reviewed_by_name = this.current?.name ?? null
    row.reviewed_at = nowIso()
    if (status === 'DIFFERENT_PERSON' || status === 'KEPT_BOTH') {
      for (const id of [row.person_id_a, row.person_id_b]) {
        const p = this.person(id)
        if (p?.status === 'FOR_REVIEW') p.status = 'ACTIVE'
      }
    }
    this.audit('DUPLICATE_REVIEWED', 'DUPLICATE_CASE', caseId, row.notes ?? '', { status }, notes, before)
    this.persist()
    return { ok: true, data: { status } }
  }

  async mergePersons(keepId: string, mergeId: string, options: MergeOptions): Promise<ApiResult<{ message: string }>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    if (!options.confirm) {
      return { ok: false, code: 'CONFIRM_REQUIRED', error: 'Merging is irreversible from the user interface. Please re-confirm.' }
    }
    if (keepId === mergeId) return { ok: false, error: 'A record cannot be merged into itself.' }
    if (!options.reason?.trim()) return { ok: false, code: 'REASON_REQUIRED', error: 'A reason is required for the audit trail.' }
    const keep = this.person(keepId)
    const loser = this.person(mergeId)
    if (!keep || !loser) return { ok: false, error: 'One of the records no longer exists.', code: 'NOT_FOUND' }
    if (loser.merged_into) return { ok: false, code: 'ALREADY_MERGED', error: 'That record has already been merged into another master record.' }
    if (keep.merged_into) return { ok: false, code: 'TARGET_MERGED', error: 'The surviving record itself has been merged away.' }

    const before = { ...keep }
    const resolved = options.resolved ?? {}
    for (const [field, value] of Object.entries(resolved)) {
      if (!value) continue
      if (field === 'date_of_birth') keep.date_of_birth = normalizeDate(value) || keep.date_of_birth
      else (keep as unknown as Record<string, unknown>)[field] = value
    }
    keep.middle_name = keep.middle_name ?? loser.middle_name
    keep.suffix = keep.suffix ?? loser.suffix
    keep.date_of_birth = keep.date_of_birth ?? loser.date_of_birth
    keep.sex = keep.sex ?? loser.sex
    keep.civil_status = keep.civil_status ?? loser.civil_status
    keep.contact_number = keep.contact_number ?? loser.contact_number
    keep.address = keep.address ?? loser.address
    keep.purok = keep.purok ?? loser.purok
    keep.household_id = keep.household_id ?? loser.household_id
    keep.remarks = [keep.remarks, `Merged from ${loser.reference_no} (${fullName(loser)})`].filter(Boolean).join(' | ')
    keep.updated_at = nowIso()

    // move barangay history across, keeping exactly one open residency
    const keepHist = this.db.history[keepId] ?? []
    keepHist.forEach((h) => { if (!h.effective_to) { h.effective_to = new Date().toISOString().slice(0, 10); h.status = 'ENDED' } })
    for (const h of this.db.history[mergeId] ?? []) {
      const duplicate = keepHist.some((k) => k.barangay_id === h.barangay_id && k.effective_from === h.effective_from)
      if (!duplicate) keepHist.push({ ...h, id: uid('h') })
    }
    this.db.history[keepId] = keepHist
    delete this.db.history[mergeId]

    // re-point duplicate cases, then close the merged pair
    for (const c of this.db.cases) {
      if (c.person_id_a === mergeId && c.person_id_b !== keepId) c.person_id_a = keepId
      else if (c.person_id_b === mergeId && c.person_id_a !== keepId) c.person_id_b = keepId
    }
    for (const c of this.db.cases) {
      if ((c.person_id_a === keepId && c.person_id_b === mergeId) || (c.person_id_a === mergeId && c.person_id_b === keepId)) {
        c.status = 'MERGED'
        c.resolution = 'MERGED'
        c.notes = [c.notes, `Merged by ${this.current?.name}: ${options.reason}`].filter(Boolean).join(' | ')
        c.reviewed_by_name = this.current?.name ?? null
        c.reviewed_at = nowIso()
      }
    }

    loser.status = 'ARCHIVED'
    loser.merged_into = keepId
    loser.merged_at = nowIso()
    loser.remarks = [loser.remarks, `Archived: merged into ${keep.reference_no}`].filter(Boolean).join(' | ')

    this.audit('MERGED', 'PERSONS', keepId, `${fullName(keep)} ← ${fullName(loser)}`, {
      surviving_record: { id: keepId, reference_no: keep.reference_no, name: fullName(keep) },
      merged_record: { id: mergeId, reference_no: loser.reference_no, name: fullName(loser) },
      resolved_fields: resolved,
      fields_retained_from_loser: {
        middle_name: loser.middle_name, date_of_birth: loser.date_of_birth, sex: loser.sex,
        contact_number: loser.contact_number, address: loser.address, purok: loser.purok,
      },
    }, options.reason, before)
    this.persist()
    return {
      ok: true,
      data: { message: `Merged ${fullName(loser)} into ${fullName(keep)}. The duplicate record was archived (not deleted) and the merge was logged.` },
    }
  }

  // ------------------------------------------------------------------ import
  async importCreateBatch(fileName: string, rows: PersonInput[], defaultBarangayId?: string | null): Promise<ApiResult<{ batch_id: string }>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const id = uid('ib')
    const batch: ImportBatchRecord = {
      id, file_name: fileName, status: 'VALIDATED', created_at: nowIso(),
      default_barangay_id: defaultBarangayId ?? null, rows: [],
    }
    this.db.importBatches.unshift(batch)

    const seen = new Map<string, number>()
    const thresholds = this.thresholds()
    for (let i = 0; i < rows.length; i++) {
      const input = rows[i]
      const issues: string[] = []
      let severity: ImportRow['severity'] = 'OK'
      const escalate = (level: ImportRow['severity']) => {
        if (severity === 'ERROR') return
        if (level === 'ERROR') severity = 'ERROR'
        else if (severity === 'OK') severity = 'WARNING'
      }

      const normalized: PersonInput = {
        first_name: (input.first_name ?? '').trim().replace(/\s+/g, ' '),
        middle_name: (input.middle_name ?? '')?.trim().replace(/\s+/g, ' ') || null,
        last_name: (input.last_name ?? '').trim().replace(/\s+/g, ' '),
        suffix: (input.suffix ?? '')?.trim().toUpperCase() || null,
        date_of_birth: normalizeDate(input.date_of_birth) || null,
        sex: (input.sex ?? '')?.toString().toUpperCase() || null,
        civil_status: (input.civil_status ?? '')?.toString().toUpperCase() || null,
        contact_number: input.contact_number?.toString().trim() || null,
        address: input.address?.trim() || null,
        purok: input.purok?.trim() || null,
        barangay_id: input.barangay_id ?? defaultBarangayId ?? null,
      }

      if (!normalized.first_name) { issues.push('MISSING_FIRST_NAME'); severity = 'ERROR' }
      if (!normalized.last_name) { issues.push('MISSING_LAST_NAME'); severity = 'ERROR' }
      const rawDob = input.date_of_birth?.toString().trim()
      if (rawDob && !normalized.date_of_birth) {
        escalate('WARNING')
        issues.push('INVALID_DATE_OF_BIRTH')
      } else if (!normalized.date_of_birth) {
        escalate('WARNING')
        issues.push('MISSING_BIRTHDATE')
      }
      if (!normalized.sex || !['MALE', 'FEMALE'].includes(normalized.sex)) {
        if (normalized.sex === 'M') normalized.sex = 'MALE'
        else if (normalized.sex === 'F') normalized.sex = 'FEMALE'
        else { normalized.sex = null; escalate('WARNING'); issues.push('MISSING_OR_INVALID_SEX') }
      }
      const digits = (normalized.contact_number ?? '').replace(/\D/g, '')
      if (normalized.contact_number && digits.length < 7) {
        escalate('WARNING')
        issues.push('INVALID_CONTACT_NUMBER')
      } else if (!normalized.contact_number) {
        issues.push('MISSING_CONTACT')
      }
      if (!normalized.address) issues.push('INCOMPLETE_ADDRESS')
      if (!normalized.barangay_id) { escalate('WARNING'); issues.push('MISSING_BARANGAY') }

      const key = identityKey(normalized)
      let matchScore: number | null = null
      let matchPerson: PersonIndexRow | null = null
      let band: string | null = null
      if (severity !== 'ERROR') {
        const matches = await this.checkDuplicates({
          id: 'row', first_name: normalized.first_name, middle_name: normalized.middle_name ?? null,
          last_name: normalized.last_name, suffix: normalized.suffix ?? null,
          date_of_birth: normalized.date_of_birth ?? null, sex: normalized.sex ?? null,
          purok: normalized.purok ?? null, address: normalized.address ?? null,
          contact_number: normalized.contact_number ?? null, barangay_id: normalized.barangay_id ?? null,
          barangay_name: this.db.barangays.find((b) => b.id === normalized.barangay_id)?.name ?? null,
        })
        const top = matches[0]
        if (top) {
          matchScore = top.score.score
          band = top.score.band
          matchPerson = this.toIndex(this.person(top.person.id) as Person)
          if (top.score.band === 'VERY_LIKELY') { issues.push('EXISTING_MEMBER_MATCH'); escalate('WARNING') }
          else if (top.score.score >= thresholds.notice) { issues.push('POSSIBLE_EXISTING_MEMBER'); escalate('WARNING') }
        }
        if (seen.has(key) && key !== '||||') {
          issues.push('DUPLICATE_IN_FILE')
          escalate('WARNING')
        }
        seen.set(key, i)
      }

      batch.rows.push({
        id: `${id}-${i + 1}`,
        row_no: i + 1,
        raw: input as unknown as Record<string, unknown>,
        normalized,
        issues,
        severity,
        match_score: matchScore,
        band,
        decision: severity === 'ERROR' ? 'SKIP' : band === 'VERY_LIKELY' ? 'SKIP' : 'PENDING',
        match_person: matchPerson,
      })
    }

    this.persist()
    return { ok: true, data: { batch_id: id } }
  }

  async importSummary(batchId: string): Promise<ImportSummary | null> {
    const batch = this.db.importBatches.find((b) => b.id === batchId)
    if (!batch) return null
    const rows = batch.rows
    const issueBreakdown: Record<string, number> = {}
    for (const r of rows) for (const i of r.issues) issueBreakdown[i] = (issueBreakdown[i] ?? 0) + 1
    return {
      batch_id: batch.id, file_name: batch.file_name, status: batch.status, created_at: batch.created_at,
      total_rows: rows.length,
      clean_rows: rows.filter((r) => r.severity === 'OK').length,
      warning_rows: rows.filter((r) => r.severity === 'WARNING').length,
      error_rows: rows.filter((r) => r.severity === 'ERROR').length,
      unique_rows: rows.filter((r) => !r.match_score && r.severity !== 'ERROR').length,
      duplicate_rows: rows.filter((r) => r.match_score !== null).length,
      in_file_duplicates: rows.filter((r) => r.issues.includes('DUPLICATE_IN_FILE')).length,
      missing_birthdates: rows.filter((r) => r.issues.includes('MISSING_BIRTHDATE')).length,
      invalid_dates: rows.filter((r) => r.issues.includes('INVALID_DATE_OF_BIRTH')).length,
      missing_sex: rows.filter((r) => r.issues.includes('MISSING_OR_INVALID_SEX')).length,
      invalid_contacts: rows.filter((r) => r.issues.includes('INVALID_CONTACT_NUMBER')).length,
      missing_barangay: rows.filter((r) => r.issues.includes('MISSING_BARANGAY')).length,
      approved_rows: rows.filter((r) => r.decision === 'IMPORT').length,
      imported_rows: rows.filter((r) => r.imported_person_id).length,
      issue_breakdown: issueBreakdown,
    }
  }

  async importRows(batchId: string, filter?: { severity?: string; decision?: string; limit?: number; offset?: number }): Promise<ImportRow[]> {
    const batch = this.db.importBatches.find((b) => b.id === batchId)
    if (!batch) return []
    let rows = batch.rows
    if (filter?.severity) rows = rows.filter((r) => r.severity === filter.severity)
    if (filter?.decision) rows = rows.filter((r) => r.decision === filter.decision)
    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? 100
    return rows.slice(offset, offset + limit)
  }

  async importSetDecision(rowId: string | number, decision: string): Promise<ApiResult<unknown>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN', 'ENCODER'])
    if (denial) return denial
    for (const batch of this.db.importBatches) {
      const row = batch.rows.find((r) => String(r.id) === String(rowId))
      if (row) {
        row.decision = decision as ImportRow['decision']
        this.persist()
        return { ok: true, data: { row_no: row.row_no, decision } }
      }
    }
    return { ok: false, error: 'Import row not found.' }
  }

  async importSetAllDecisions(
    batchId: string, severity: string | null, decision: string, duplicatesOnly = false,
  ): Promise<ApiResult<{ updated?: number }>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const batch = this.db.importBatches.find((b) => b.id === batchId)
    if (!batch) return { ok: false, error: 'Import batch not found.', code: 'NOT_FOUND' }
    let n = 0
    for (const row of batch.rows) {
      if (severity && row.severity !== severity) continue
      if (decision === 'IMPORT' && row.severity === 'ERROR') continue
      if (duplicatesOnly && !((row.issues ?? []).includes('DUPLICATE_IN_FILE') || row.match_score != null)) continue
      row.decision = decision as ImportRow['decision']
      n += 1
    }
    this.persist()
    return { ok: true, data: { updated: n } }
  }



  async importCommit(batchId: string, _defaultBarangayId?: string | null): Promise<ApiResult<{
    imported: number; duplicates_parked: number; skipped: number; linked: number; message: string
  }>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return { ok: false, error: denial.error, code: denial.code }
    const batch = this.db.importBatches.find((b) => b.id === batchId)
    if (!batch) return { ok: false, error: 'Import batch not found.' }
    if (batch.status === 'IMPORTED') return { ok: false, error: 'This batch was already imported.' }

    let imported = 0
    let parked = 0
    let skipped = 0
    for (const row of batch.rows) {
      if (row.decision !== 'IMPORT' || row.severity === 'ERROR' || row.imported_person_id) {
        if (row.decision !== 'IMPORT') skipped++
        continue
      }
      const result = await this.createPerson(row.normalized, { reason: `Bulk import: ${batch.file_name}` })
      if (result.ok && result.person) {
        row.imported_person_id = result.person.id
        imported++
      } else if (result.code === 'DUPLICATE_REVIEW_REQUIRED') {
        row.decision = 'SKIP'
        row.severity = 'WARNING'
        if (!row.issues.includes('EXISTING_MEMBER_MATCH')) row.issues.push('EXISTING_MEMBER_MATCH')
        if (result.matches?.[0]) {
          row.match_score = row.match_score ?? result.matches[0].score.score
          row.match_person = this.toIndex(this.person(result.matches[0].person.id) as Person)
        }
        parked++
      } else {
        row.decision = 'SKIP'
        skipped++
      }
    }
    batch.status = 'IMPORTED'
    this.audit('IMPORTED', 'IMPORT_BATCH', batch.id, batch.file_name, {
      imported, duplicates_parked: parked, skipped,
    }, 'Bulk import committed')
    this.persist()
    return {
      ok: true,
      data: {
        imported, duplicates_parked: parked, skipped, linked: 0,
        message: `${imported} record(s) imported; ${parked} likely duplicate(s) were held back for review.`,
      },
    }
  }

  async listImportBatches(): Promise<ImportSummary[]> {
    const out: ImportSummary[] = []
    for (const b of this.db.importBatches) {
      const summary = await this.importSummary(b.id)
      if (summary) out.push(summary)
    }
    return out
  }

  // ------------------------------------------------------------------ audit + users
  async listAudit(filters?: {
    query?: string; action?: string | null; entity?: string | null; user_id?: string | null
    from?: string | null; to?: string | null; limit?: number; offset?: number
  }): Promise<{ total: number; rows: AuditLogRow[] }> {
    const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 200)
    const offset = Math.max(filters?.offset ?? 0, 0)
    const q = (filters?.query ?? '').toLowerCase()
    let rows = this.db.audit.slice()
    if (this.role() === 'ENCODER') rows = rows.filter((r) => r.user_id === this.current?.id)
    if (filters?.action) rows = rows.filter((r) => r.action === filters.action)
    if (filters?.entity) rows = rows.filter((r) => r.entity_type === filters.entity)
    if (filters?.user_id) rows = rows.filter((r) => r.user_id === filters.user_id)
    if (filters?.from) rows = rows.filter((r) => r.timestamp >= (filters.from as string))
    if (filters?.to) rows = rows.filter((r) => r.timestamp <= (filters.to as string))
    if (q) {
      rows = rows.filter((r) =>
        [r.entity_label, r.user_name, r.reason, r.action].some((v) => (v ?? '').toLowerCase().includes(q)))
    }
    return { total: rows.length, rows: rows.slice(offset, offset + limit) }
  }

  async logEvent(action: string, entityType: string, entityId?: string | null, label?: string | null,
    newValues?: unknown, reason?: string | null): Promise<void> {
    this.audit(action, entityType, entityId ?? null, label ?? null, newValues ?? null, reason ?? null)
    this.persist()
  }

  async listUsers(): Promise<ManagedUser[]> {
    return this.db.users.map(({ password_hash: _ignored, ...u }) => u)
  }

  async upsertUser(input: Partial<ManagedUser> & { name: string; email: string; role: string }): Promise<ApiResult<ManagedUser>> {
    const denial = this.require(['SYSTEM_ADMIN'])
    if (denial) return denial
    if (!input.name?.trim() || !input.email?.trim()) return { ok: false, error: 'Name and email are required.' }
    if (!['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN', 'VIEWER'].includes(input.role)) {
      return { ok: false, error: 'Invalid role.' }
    }
    const email = input.email.trim().toLowerCase()
    const existing = this.db.users.find((u) => u.id === input.id || u.email === email)
    if (existing) {
      const before = { ...existing }
      existing.name = input.name.trim()
      existing.email = email
      existing.role = input.role as ManagedUser['role']
      existing.active = input.active ?? existing.active
      existing.barangay_scope = input.barangay_scope ?? existing.barangay_scope
      this.audit('USER_UPDATED', 'USERS', existing.id, `${existing.name} (${existing.email})`,
        { role: existing.role, active: existing.active }, null, before)
      this.persist()
      const { password_hash: _p, ...safe } = existing
      return { ok: true, data: safe }
    }
    const created: ManagedUser & { password_hash: string } = {
      id: uid('u'), name: input.name.trim(), email, role: input.role as ManagedUser['role'],
      active: input.active ?? true, barangay_scope: input.barangay_scope ?? null,
      created_at: nowIso(), last_login: null, password_hash: '',
    }
    created.password_hash = await sha256Hex(`${SALT}:${email}:${(input as { password?: string }).password ?? 'ChangeMe@2026'}`)
    this.db.users.push(created)
    this.audit('USER_CREATED', 'USERS', created.id, `${created.name} (${created.email})`,
      { role: created.role, active: created.active }, null)
    this.persist()
    const { password_hash: _p, ...safe } = created
    return { ok: true, data: safe }
  }

  // ------------------------------------------------------------------ sync (local mode: nothing to push)
  pendingChanges(): OutboxItem[] {
    return this.db.outbox
  }

  async syncNow(): Promise<{ pushed: number; failed: number; conflicts: number }> {
    this.db.lastSyncAt = nowIso()
    this.persist()
    return { pushed: 0, failed: 0, conflicts: 0 }
  }

  async discardPending(id: string): Promise<void> {
    this.db.outbox = this.db.outbox.filter((o) => o.id !== id)
    this.persist()
  }

  lastSyncedAt(): string | null {
    return this.db.lastSyncAt
  }

  /**
   * After a queued record is accepted by the server it gets the server's id:
   * re-point everything that referenced the temporary offline id.
   */
  remapPersonId(oldId: string, newId: string) {
    if (!oldId || !newId || oldId === newId) return
    for (const p of this.db.persons) {
      if (p.id === oldId) p.id = newId
      if (p.merged_into === oldId) p.merged_into = newId
    }
    if (this.db.history[oldId]) {
      this.db.history[newId] = this.db.history[oldId]
      delete this.db.history[oldId]
    }
    for (const c of this.db.cases) {
      if (c.person_id_a === oldId) c.person_id_a = newId
      if (c.person_id_b === oldId) c.person_id_b = newId
    }
    for (const a of this.db.audit) {
      if (a.entity_id === oldId) a.entity_id = newId
    }
    for (const batch of this.db.importBatches) {
      for (const row of batch.rows) {
        if (row.imported_person_id === oldId) row.imported_person_id = newId
        if (row.match_person?.id === oldId) row.match_person = { ...row.match_person, id: newId }
      }
    }
    this.persist()
  }

  setOutbox(items: OutboxItem[]) {
    this.db.outbox = items
    this.persist()
  }

  /** Used by the sync layer when it mirrors remote data locally. */
  replaceMirror(payload: { barangays?: Barangay[]; persons?: Person[]; cases?: DuplicateCase[]; programs?: SubsidyProgram[]; beneficiaries?: SubsidyBeneficiary[] }) {
    if (payload.barangays) this.db.barangays = payload.barangays
    if (payload.persons) this.db.persons = payload.persons
    if (payload.cases) this.db.cases = payload.cases
    if (payload.programs) this.db.programs = payload.programs
    if (payload.beneficiaries) this.db.beneficiaries = payload.beneficiaries
    this.persist()
  }

  queueOutbox(item: Omit<OutboxItem, 'id' | 'created_at' | 'status' | 'attempts'>) {
    this.db.outbox.push({
      id: uid('ob'), created_at: nowIso(), status: 'PENDING', attempts: 0, ...item,
    } as OutboxItem)
    this.persist()
  }

  outboxSnapshot(): OutboxItem[] {
    return this.db.outbox
  }

  updateOutbox(id: string, patch: Partial<OutboxItem>) {
    const item = this.db.outbox.find((o) => o.id === id)
    if (item) Object.assign(item, patch)
    this.persist()
  }

  setLastSync(at: string | null) {
    this.db.lastSyncAt = at
    this.persist()
  }

  // ------------------------------------------------------------- subsidies
  async listSubsidyPrograms(): Promise<SubsidyProgram[]> {
    return this.db.programs.map((p) => ({
      ...p,
      beneficiaries: this.db.beneficiaries.filter((b) => b.program_id === p.id).length,
      verified: this.db.beneficiaries.filter((b) => b.program_id === p.id && b.verified).length,
    }))
  }

  async upsertSubsidyProgram(input: Partial<SubsidyProgram> & { name: string }): Promise<ApiResult<SubsidyProgram>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    let row: SubsidyProgram
    if (input.id) {
      const found = this.db.programs.find((x) => x.id === input.id)
      if (!found) return { ok: false, code: 'NOT_FOUND', error: 'Programme not found on this device.' }
      Object.assign(found, {
        name: input.name || found.name,
        description: input.description !== undefined ? input.description : found.description,
        period_start: input.period_start !== undefined ? input.period_start : found.period_start,
        period_end: input.period_end !== undefined ? input.period_end : found.period_end,
        active: input.active !== undefined ? input.active : found.active,
      })
      row = found
      this.audit('UPDATED', 'SUBSIDY_PROGRAMS', row.id, row.name, row, null)
    } else {
      row = {
        id: uid('sp'), name: input.name, description: input.description ?? null,
        period_start: input.period_start ?? null, period_end: input.period_end ?? null,
        active: input.active ?? true, created_at: nowIso(),
      }
      this.db.programs.push(row)
      this.audit('CREATED', 'SUBSIDY_PROGRAMS', row.id, row.name, row, null)
    }
    this.persist()
    return { ok: true, data: row }
  }

  async listSubsidyBeneficiaries(programId: string, barangayId?: string | null): Promise<SubsidyBeneficiary[]> {
    return this.db.beneficiaries
      .filter((b) => b.program_id === programId && (!barangayId || b.barangay_id === barangayId))
      .map((b) => {
        const person = this.db.persons.find((x) => x.id === b.person_id)
        return {
          ...b,
          person_name: person ? fullName(person) : undefined,
          reference_no: person?.reference_no,
          person_barangay: person ? (this.db.barangays.find((x) => x.id === person.barangay_id)?.name ?? '') : undefined,
        }
      })
      .sort((a, b) => (a.person_name ?? '').localeCompare(b.person_name ?? '', 'en'))
  }

  async addSubsidyBeneficiary(input: {
    program_id: string; person_id: string; barangay_id?: string | null
    classification_code?: string | null; verified?: boolean; paper_ref?: string | null; notes?: string | null
  }): Promise<ApiResult<SubsidyBeneficiary>> {
    const denial = this.require(['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const person = this.db.persons.find((x) => x.id === input.person_id)
    if (!person) return { ok: false, code: 'NOT_FOUND', error: 'That member is not in the registry on this device. Re-sync and try again.' }
    if (this.db.beneficiaries.some((b) => b.program_id === input.program_id && b.person_id === input.person_id)) {
      return { ok: false, code: 'ALREADY_LISTED', error: `${fullName(person)} is already on this programme list.` }
    }
    const row: SubsidyBeneficiary = {
      id: uid('sb'), program_id: input.program_id, person_id: person.id,
      barangay_id: input.barangay_id ?? person.barangay_id,
      classification_code: input.classification_code ?? person.classification_code ?? null,
      verified: input.verified ?? false, paper_ref: input.paper_ref ?? null,
      notes: input.notes ?? null, created_at: nowIso(),
    }
    this.db.beneficiaries.push(row)
    this.persist()
    this.audit('CREATED', 'SUBSIDY_BENEFICIARIES', row.id, fullName(person), row, null)
    return { ok: true, data: row }
  }

  async removeSubsidyBeneficiary(id: string, reason?: string | null): Promise<ApiResult<{ id: string }>> {
    const denial = this.require(['ADMINISTRATOR', 'SYSTEM_ADMIN'])
    if (denial) return denial
    const row = this.db.beneficiaries.find((b) => b.id === id)
    if (!row) return { ok: false, code: 'NOT_FOUND', error: 'Beneficiary row not found on this device.' }
    this.db.beneficiaries = this.db.beneficiaries.filter((b) => b.id !== id)
    this.persist()
    this.audit('DELETED', 'SUBSIDY_BENEFICIARIES', row.id, row.person_name ?? row.person_id, row, reason ?? null)
    return { ok: true, data: { id } }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
