/**
 * SUPABASE BACKEND (connected mode).
 *
 * Every call goes to a PostgreSQL function in the `public` schema. The
 * functions are SECURITY DEFINER with their own role checks, so a tampered
 * browser cannot bypass authorisation, and the person table has no write
 * policies at all — the only way to create a record is fn_create_person(),
 * which runs the duplicate engine and is protected by the identity index.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AuditLogRow, Barangay, DataQualityRow, DuplicateCase, DashboardStats, ManagedUser,
  OutboxItem, Person, PersonIndexRow, SystemSettings,
  SubsidyProgram, SubsidyBeneficiary,
} from './types'
import type {
  ApiResult, CreatePersonResult, DuplicateComparison, ImportRow, ImportSummary, MergeOptions,
  PersonDetail, PersonInput, RegistryApi, ReportKind, SearchQuery, SearchResult, SessionUser,
} from './api'
import type { DuplicateMatch, PersonComparable } from './duplicateEngine'
import { getSupabase } from './supabase'

const SESSION_KEY = 'nmbr.session.v1'

type RpcName =
  | 'fn_search_persons' | 'fn_person_index' | 'fn_person_detail' | 'fn_check_person_duplicates'
  | 'fn_bulk_check_duplicates' | 'fn_create_person' | 'fn_update_person' | 'fn_transfer_barangay'
  | 'fn_set_person_status' | 'fn_list_duplicate_cases' | 'fn_compare_persons' | 'fn_open_duplicate_case'
  | 'fn_resolve_duplicate_case' | 'fn_merge_persons' | 'fn_barangays' | 'fn_upsert_barangay'
  | 'fn_dashboard_stats' | 'fn_data_quality' | 'fn_quality_records' | 'fn_reports' | 'fn_list_audit'
  | 'fn_log_event' | 'fn_list_users' | 'fn_upsert_user' | 'fn_get_settings' | 'fn_save_settings'
  | 'fn_import_create_batch' | 'fn_import_add_rows' | 'fn_import_summary' | 'fn_import_rows'
  | 'fn_import_set_decision' | 'fn_import_set_all_decisions' | 'fn_import_commit' | 'fn_link_auth_user'
  | 'fn_subsidy_programs' | 'fn_subsidy_upsert_program' | 'fn_subsidy_beneficiaries'
  | 'fn_subsidy_add_beneficiary' | 'fn_subsidy_remove_beneficiary'
  | 'fn_schema_info'

export class RemoteError extends Error {
  code?: string
  detail?: unknown
  isNetwork: boolean
  constructor(message: string, code?: string, detail?: unknown, isNetwork = false) {
    super(message)
    this.code = code
    this.detail = detail
    this.isNetwork = isNetwork
  }
}

/**
 * True when the request never reached PostgreSQL.
 *
 * Every browser words this differently — Chrome "Failed to fetch", Safari
 * "Load failed", Firefox "NetworkError when attempting to fetch resource",
 * Node/undici "fetch failed" — and all of them throw a TypeError. Getting this
 * wrong is costly: a dropped connection misread as an answer makes the app
 * think the database is fine and quietly lose confidence in the server.
 */
function isNetworkError(err: unknown): boolean {
  if (!err) return false
  const e = err as { message?: string; code?: string; status?: number; name?: string }
  const message = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|fetch failed|load failed|NetworkError|network request failed|network error|timeout|timed out|ERR_|net::|ECONN|ENOTFOUND|ENETUNREACH|offline/i.test(message)) {
    return true
  }
  // A rejected fetch (transport level) is always a TypeError and never carries a
  // PostgREST/SQL error code.
  return err instanceof TypeError && !e.code && e.status == null
}

/**
 * True when PostgREST answered, but the NMBR migrations have not been deployed.
 *
 * This is a *configuration* state, not a failed change: the server is reachable
 * and healthy, it simply does not know the registry yet. The client must keep
 * the encoder working locally and clearly say "the database has not been set up"
 * instead of reporting a queue of failures.
 *
 *   PGRST202 — Could not find the function public.fn_x in the schema cache
 *   PGRST205 — Could not find the table 'public.x' in the schema cache
 *   42883    — undefined_function (PostgreSQL)
 *   42P01    — undefined_table (PostgreSQL)
 */
export function isSchemaMissingError(err: unknown): boolean {
  if (!err) return false
  const e = err as { code?: string; message?: string; details?: string; hint?: string }
  const code = String(e.code ?? '')
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42883' || code === '42P01') return true
  const text = [e.message, e.details, e.hint].filter(Boolean).join(' ')
  return /could not find the (function|table)|in the schema cache|relation .* does not exist|function .* does not exist/i.test(text)
}

/** Structured errors raised by the database guard arrive as P0005 with JSON detail. */
function parseDbError(err: unknown): RemoteError {
  if (!err || typeof err !== 'object') return new RemoteError(String(err))
  const e = err as { message?: string; code?: string; details?: string; hint?: string; detail?: string }
  const message = e.message ?? 'Unexpected database error'
  const rawDetail = e.details ?? e.detail
  let detail: unknown = rawDetail
  if (rawDetail && typeof rawDetail === 'string' && rawDetail.trim().startsWith('{')) {
    try {
      detail = JSON.parse(rawDetail)
    } catch {
      /* keep the raw string */
    }
  }
  const clean = message.replace(/^NMBR_[A-Z_]+:\s*/, '')
  if (isSchemaMissingError(e)) {
    return new RemoteError(
      'The municipal database has not been set up yet. Run the NMBR setup SQL in Supabase, then retry.',
      'NOT_PROVISIONED', detail, false,
    )
  }
  return new RemoteError(clean, e.code, detail, isNetworkError(e))
}

export class RemoteApi implements RegistryApi {
  readonly mode = 'supabase' as const
  readonly offlineCapable = false

  private sb: SupabaseClient
  private current: SessionUser | null = null

  constructor(sb?: SupabaseClient) {
    const client = sb ?? getSupabase()
    if (!client) throw new Error('Supabase is not configured')
    this.sb = client
    this.current = this.readCachedSession()
  }

  /**
   * Is the NMBR schema deployed on this Supabase project?
   *
   *   'ready'   — fn_schema_info() answered, so the migrations ran
   *   'missing' — the project answered but does not know the registry
   *   'unknown' — could not tell (offline or signed out)
   */
  async probeSchema(): Promise<'ready' | 'missing' | 'unknown'> {
    try {
      await this.rpc('fn_schema_info')
      return 'ready'
    } catch (err) {
      const parsed = err instanceof RemoteError ? err : parseDbError(err)
      if (parsed.code === 'NOT_PROVISIONED') return 'missing'
      if (parsed.isNetwork) return 'unknown'
      // Signed out, or a permission/validation error: the function exists.
      return parsed.code === '401' || parsed.code === '403' ? 'unknown' : 'ready'
    }
  }

  private readCachedSession(): SessionUser | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { user: SessionUser; at: number; mode?: string }
      return parsed.user?.id ? parsed.user : null
    } catch {
      return null
    }
  }

  private cacheSession(user: SessionUser | null) {
    if (!user) {
      localStorage.removeItem(SESSION_KEY)
      return
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, at: Date.now(), mode: 'supabase' }))
  }

  private async rpc<T>(name: RpcName, params: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.sb.rpc(name as never, params as never)
    if (error) throw parseDbError(error)
    return data as T
  }

  // ------------------------------------------------------------------ session
  async signIn(email: string, password: string): Promise<ApiResult<SessionUser>> {
    try {
      const { data, error } = await this.sb.auth.signInWithPassword({ email: email.trim(), password })
      if (error) {
        const friendly = /Invalid login credentials/i.test(error.message)
          ? 'Incorrect email address or password.'
          : /Email not confirmed/i.test(error.message)
            ? 'This account still needs email confirmation. Ask the system administrator.'
            : error.message
        return { ok: false, error: friendly, code: 'AUTH_FAILED' }
      }
      if (!data.user) return { ok: false, error: 'Sign in failed.', code: 'AUTH_FAILED' }

      // Link the auth user to the NMBR profile and fetch the role.
      const linked = await this.rpc<{ ok: boolean; user?: SessionUser; error?: string }>('fn_link_auth_user')
      if (!linked?.ok || !linked.user) {
        await this.sb.auth.signOut()
        return { ok: false, error: linked?.error ?? 'No NMBR profile is linked to this account.', code: 'NO_PROFILE' }
      }
      this.current = linked.user
      this.cacheSession(linked.user)
      return { ok: true, data: linked.user }
    } catch (err) {
      const parsed = parseDbError(err)
      if (parsed.isNetwork) {
        return { ok: false, error: 'No connection to the municipal server. Use offline mode instead.', code: 'OFFLINE' }
      }
      return { ok: false, error: parsed.message, code: parsed.code }
    }
  }

  async signOut(): Promise<void> {
    try {
      if (this.current) {
        await this.rpc('fn_log_event', {
          p_action: 'LOGOUT', p_entity_type: 'USERS', p_entity_id: this.current.id,
          p_entity_label: this.current.name,
        })
      }
    } catch {
      /* logging out must never fail because of a network hiccup */
    }
    await this.sb.auth.signOut()
    this.current = null
    this.cacheSession(null)
  }

  async restoreSession(): Promise<SessionUser | null> {
    const { data } = await this.sb.auth.getSession()
    if (!data.session) {
      this.current = null
      return null
    }
    try {
      const linked = await this.rpc<{ ok: boolean; user?: SessionUser; error?: string }>('fn_link_auth_user')
      if (linked?.ok && linked.user) {
        this.current = linked.user
        this.cacheSession(linked.user)
        return linked.user
      }
      return this.current
    } catch {
      // Offline: fall back to the cached profile so the UI can show the mirror.
      return this.current
    }
  }

  touchSession(): void {
    const cached = this.readCachedSession()
    if (cached) this.cacheSession(cached)
  }

  sessionExpired(): boolean {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return true
    try {
      const parsed = JSON.parse(raw) as { at: number }
      const timeout = 30 * 60_000
      return Date.now() - parsed.at > timeout
    } catch {
      return true
    }
  }

  getSession(): SessionUser | null {
    return this.current
  }

  setSession(user: SessionUser | null) {
    this.current = user
    this.cacheSession(user)
  }

  // ------------------------------------------------------------------ reference
  async listBarangays(includeInactive = false): Promise<Barangay[]> {
    const rows = await this.rpc<Barangay[]>('fn_barangays', { p_include_inactive: includeInactive, p_query: '' })
    return rows ?? []
  }

  async upsertBarangay(input: Partial<Barangay> & { name: string }): Promise<ApiResult<Barangay>> {
    try {
      const res = await this.rpc<{ ok: boolean; barangay?: Barangay; error?: string }>('fn_upsert_barangay', { p: input })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Could not save the barangay.' }
      return { ok: true, data: res.barangay as Barangay }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async getSettings(): Promise<SystemSettings> {
    const res = await this.rpc<{
      weights: Record<string, number>; thresholds: Record<string, number>
      system: Record<string, unknown>; updated_at?: string
    }>('fn_get_settings')
    return {
      weights: res?.weights ?? {},
      thresholds: res?.thresholds ?? {},
      session_timeout_minutes: Number(res?.system?.session_timeout_minutes ?? 30),
      mask_contact_in_lists: Boolean(res?.system?.mask_contact_in_lists ?? true),
      block_on_very_likely: Boolean(res?.system?.block_on_very_likely ?? true),
      require_reason_on_edit: Boolean(res?.system?.require_reason_on_edit ?? true),
      municipality: String(res?.system?.municipality ?? 'Nabua'),
      province: String(res?.system?.province ?? 'Camarines Sur'),
      updated_at: res?.updated_at,
    }
  }

  async saveSettings(patch: { weights?: unknown; thresholds?: unknown; system?: unknown }): Promise<ApiResult<SystemSettings>> {
    try {
      const res = await this.rpc<{ ok: boolean; error?: string }>('fn_save_settings', {
        p_weights: patch.weights ?? null, p_thresholds: patch.thresholds ?? null, p_system: patch.system ?? null,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Could not save the settings.' }
      return { ok: true, data: await this.getSettings() }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  // ------------------------------------------------------------------ reads
  async dashboardStats(): Promise<DashboardStats> {
    return this.rpc<DashboardStats>('fn_dashboard_stats')
  }

  async searchPersons(query: SearchQuery): Promise<SearchResult> {
    const args = {
      p_query: query.query ?? '',
      p_barangay_id: query.barangay_id ?? null,
      p_status: query.status ?? null,
      p_sex: query.sex ?? null,
      p_purok: query.purok ?? null,
      p_duplicates_only: query.duplicates_only ?? false,
      p_for_review_only: query.for_review_only ?? false,
      p_attention_only: query.attention_only ?? false,
      p_sort: query.sort ?? 'name',
      p_dir: query.dir ?? 'asc',
      p_limit: query.limit ?? 25,
      p_offset: query.offset ?? 0,
    }
    const call = async (withSince: boolean) => this.rpc<{ total: number; rows: Person[] }>(
      'fn_search_persons',
      withSince && query.created_since ? { ...args, p_created_since: query.created_since } : args,
    )
    try {
      const res = await call(true)
      return { total: Number(res?.total ?? 0), rows: res?.rows ?? [] }
    } catch (err) {
      // A database that has not applied migration 0010 yet does not know the
      // p_created_since argument: fall back to the unfiltered search instead
      // of showing the encoder an error page (the card count simply will not
      // match until the migration runs).
      if (query.created_since && String((err as { message?: string }).message ?? '').includes('fn_search_persons')) {
        const res = await call(false)
        return { total: Number(res?.total ?? 0), rows: res?.rows ?? [] }
      }
      throw err
    }
  }

  async personIndex(offset = 0, limit = 10000): Promise<PersonIndexRow[]> {
    const res = await this.rpc<{ rows: PersonIndexRow[] }>('fn_person_index',
      { p_barangay_id: null, p_limit: limit, p_offset: offset })
    return res?.rows ?? []
  }

  async listSubsidyPrograms(): Promise<SubsidyProgram[]> {
    const res = await this.rpc<{ rows: SubsidyProgram[] }>('fn_subsidy_programs', {})
    return res?.rows ?? []
  }

  async upsertSubsidyProgram(input: Partial<SubsidyProgram> & { name: string }): Promise<ApiResult<SubsidyProgram>> {
    try {
      const res = await this.rpc<{ ok: boolean; program?: SubsidyProgram; code?: string; error?: string }>(
        'fn_subsidy_upsert_program', { p: input })
      return res?.ok && res.program
        ? { ok: true, data: res.program }
        : { ok: false, code: res?.code, error: res?.error ?? 'The server refused this programme change.' }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, code: e.code, error: e.message }
    }
  }

  async listSubsidyBeneficiaries(programId: string, barangayId?: string | null): Promise<SubsidyBeneficiary[]> {
    const res = await this.rpc<{ rows: SubsidyBeneficiary[] }>('fn_subsidy_beneficiaries',
      { p_program_id: programId, p_barangay_id: barangayId ?? null })
    return res?.rows ?? []
  }

  async addSubsidyBeneficiary(input: {
    program_id: string; person_id: string; barangay_id?: string | null
    classification_code?: string | null; verified?: boolean; paper_ref?: string | null; notes?: string | null
  }): Promise<ApiResult<SubsidyBeneficiary>> {
    try {
      const res = await this.rpc<{ ok: boolean; beneficiary?: SubsidyBeneficiary; code?: string; error?: string }>(
        'fn_subsidy_add_beneficiary', { p: input })
      return res?.ok && res.beneficiary
        ? { ok: true, data: res.beneficiary }
        : { ok: false, code: res?.code, error: res?.error ?? 'The server refused this beneficiary.' }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, code: e.code, error: e.message }
    }
  }

  async removeSubsidyBeneficiary(id: string, reason?: string | null): Promise<ApiResult<{ id: string }>> {
    try {
      const res = await this.rpc<{ ok: boolean; code?: string; error?: string }>(
        'fn_subsidy_remove_beneficiary', { p_id: id, p_reason: reason })
      return res?.ok ? { ok: true, data: { id } } : { ok: false, code: res?.code, error: res?.error ?? 'Refused.' }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, code: e.code, error: e.message }
    }
  }

  /** Pre-0011 databases only know the two-argument mirror function. */
  async personIndexLegacy(): Promise<PersonIndexRow[]> {
    const res = await this.rpc<{ rows: PersonIndexRow[] }>('fn_person_index',
      { p_barangay_id: null, p_limit: 20000 })
    return res?.rows ?? []
  }

  async getPerson(id: string): Promise<PersonDetail | null> {
    return this.rpc<PersonDetail | null>('fn_person_detail', { p_person_id: id })
  }

  async checkDuplicates(candidate: PersonComparable, excludeId?: string | null): Promise<DuplicateMatch[]> {
    const rows = await this.rpc<Array<{
      person: PersonIndexRow; person_detail: Person; score: number; band: string
      reasons: DuplicateMatch['score']['reasons']; matched_fields: string[]; flags: Record<string, unknown>
    }>>('fn_check_person_duplicates', { p: candidate, p_limit: 10, p_exclude_id: excludeId ?? null })

    return (rows ?? []).map((r) => ({
      person: {
        ...r.person_detail,
        barangay_name: r.person.barangay_name ?? r.person_detail.barangay_name ?? null,
      },
      score: {
        score: Number(r.score), band: r.band as DuplicateMatch['score']['band'],
        reasons: r.reasons ?? [], matchedFields: r.matched_fields ?? [],
        flags: r.flags as unknown as DuplicateMatch['score']['flags'],
      },
    }))
  }

  async bulkCheckDuplicates(rows: PersonInput[]): Promise<Array<{ index: number; matches: DuplicateMatch[] }>> {
    const res = await this.rpc<Array<{ index: number; matches: unknown[] }>>('fn_bulk_check_duplicates', {
      p_rows: rows, p_limit_per_row: 3,
    })
    return (res ?? []).map((r) => ({
      index: r.index,
      matches: (r.matches as Array<Record<string, never>>).map((m) => {
        const mm = m as unknown as {
          person: PersonIndexRow; person_detail: Person; score: number; band: string
          reasons: DuplicateMatch['score']['reasons']; matched_fields: string[]; flags: Record<string, unknown>
        }
        return {
          person: { ...mm.person_detail, barangay_name: mm.person?.barangay_name ?? null },
          score: {
            score: Number(mm.score), band: mm.band as DuplicateMatch['score']['band'],
            reasons: mm.reasons ?? [], matchedFields: mm.matched_fields ?? [],
            flags: mm.flags as unknown as DuplicateMatch['score']['flags'],
          },
        }
      }),
    }))
  }

  async dataQuality(): Promise<DataQualityRow[]> {
    return this.rpc<DataQualityRow[]>('fn_data_quality')
  }

  async qualityRecords(metric: string, limit = 100): Promise<unknown[]> {
    const res = await this.rpc<{ rows: unknown[] }>('fn_quality_records', { p_metric: metric, p_limit: limit, p_offset: 0 })
    return res?.rows ?? []
  }

  async reports(kind: ReportKind, params?: { from?: string; to?: string; barangay_id?: string }): Promise<unknown> {
    const res = await this.rpc<{ rows: unknown }>('fn_reports', {
      p_report: kind, p_from: params?.from ?? null, p_to: params?.to ?? null,
      p_barangay_id: params?.barangay_id ?? null,
    })
    return res?.rows ?? []
  }

  // ------------------------------------------------------------------ writes
  async createPerson(input: PersonInput, opts?: { confirmedDistinct?: boolean; reason?: string }): Promise<CreatePersonResult> {
    try {
      const res = await this.rpc<{
        ok: boolean; code?: string; error?: string; band?: string; matches?: unknown[]; person?: Person
      }>('fn_create_person', {
        p: input,
        p_confirmed_distinct: opts?.confirmedDistinct ?? false,
        p_reason: opts?.reason ?? null,
      })
      if (!res?.ok) {
        return {
          ok: false, code: res?.code, error: res?.error, band: res?.band,
          matches: (res?.matches ?? []) as DuplicateMatch[],
        }
      }
      return { ok: true, person: res.person, band: res.band, matches: (res.matches ?? []) as DuplicateMatch[] }
    } catch (err) {
      const e = parseDbError(err)
      // The identity guard raises before/at insert time — surface it as a duplicate warning.
      if (e.code === 'P0005' || /duplicate key value.*identity/i.test(e.message)) {
        const detail = e.detail as { existing_person_id?: string } | undefined
        const matches = detail?.existing_person_id
          ? await this.checkDuplicates(input as PersonComparable).catch(() => [])
          : []
        return { ok: false, code: 'DUPLICATE_REVIEW_REQUIRED', error: e.message, matches }
      }
      return { ok: false, code: e.code, error: e.message }
    }
  }

  async updatePerson(id: string, patch: Partial<PersonInput>, reason?: string): Promise<ApiResult<Person>> {
    try {
      const res = await this.rpc<{ ok: boolean; code?: string; error?: string; person?: Person }>('fn_update_person', {
        p_id: id, p: patch, p_reason: reason ?? null,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Update failed.', code: res?.code }
      return { ok: true, data: res.person as Person }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async transferBarangay(input: {
    person_id: string; barangay_id: string; reason: string; effective_date?: string; notes?: string
  }): Promise<ApiResult<{ message: string }>> {
    try {
      const res = await this.rpc<{ ok: boolean; message?: string; error?: string; code?: string }>('fn_transfer_barangay', {
        p_person_id: input.person_id, p_barangay_id: input.barangay_id, p_reason: input.reason,
        p_effective_date: input.effective_date ?? null, p_notes: input.notes ?? null,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Transfer failed.', code: res?.code }
      return { ok: true, data: { message: res.message ?? 'Barangay transfer recorded.' } }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async setPersonStatus(id: string, status: string, reason: string): Promise<ApiResult<Person>> {
    try {
      const res = await this.rpc<{ ok: boolean; error?: string; code?: string; person?: Person }>('fn_set_person_status', {
        p_person_id: id, p_status: status, p_reason: reason,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Status change failed.', code: res?.code }
      return { ok: true, data: res.person as Person }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  // ------------------------------------------------------------------ duplicates
  async listDuplicateCases(filters?: {
    status?: string; barangay_id?: string | null; min_score?: number | null
    query?: string; limit?: number; offset?: number
  }): Promise<{ total: number; rows: DuplicateCase[] }> {
    const res = await this.rpc<{ total: number; rows: DuplicateCase[] }>('fn_list_duplicate_cases', {
      p_status: filters?.status ?? 'PENDING',
      p_barangay_id: filters?.barangay_id ?? null,
      p_min_score: filters?.min_score ?? null,
      p_query: filters?.query ?? '',
      p_limit: filters?.limit ?? 25,
      p_offset: filters?.offset ?? 0,
    })
    return { total: Number(res?.total ?? 0), rows: res?.rows ?? [] }
  }

  async comparePersons(a: string, b: string): Promise<DuplicateComparison | null> {
    const res = await this.rpc<{
      ok: boolean; score: number; band: string; reasons: DuplicateComparison['reasons']
      flags: Record<string, unknown>; a: Person; b: Person
    }>('fn_compare_persons', { p_a: a, p_b: b })
    if (!res?.ok) return null
    const fields: Array<[keyof Person, string]> = [
      ['first_name', 'First name'], ['middle_name', 'Middle name'], ['last_name', 'Last name'],
      ['suffix', 'Suffix'], ['date_of_birth', 'Date of birth'], ['sex', 'Sex'],
      ['civil_status', 'Civil status'], ['contact_number', 'Contact number'], ['purok', 'Purok / Sitio'],
      ['address', 'Address'], ['barangay_name', 'Barangay'], ['status', 'Status'],
    ]
    return {
      score: Number(res.score), band: res.band, reasons: res.reasons ?? [],
      flags: res.flags ?? {}, a: res.a, b: res.b,
      diff: fields.map(([field, label]) => ({
        field: String(field), label,
        a: (res.a[field] as unknown) ?? null,
        b: (res.b[field] as unknown) ?? null,
        same: String(res.a[field] ?? '').toUpperCase() === String(res.b[field] ?? '').toUpperCase(),
      })),
    }
  }

  async openDuplicateCase(a: string, b: string, source = 'MANUAL', notes?: string): Promise<ApiResult<{ case_id: string }>> {
    try {
      const res = await this.rpc<{ ok: boolean; case_id?: string; error?: string; code?: string }>('fn_open_duplicate_case', {
        p_person_a: a, p_person_b: b, p_source: source, p_notes: notes ?? null,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Could not open the duplicate case.', code: res?.code }
      return { ok: true, data: { case_id: res.case_id as string } }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async resolveDuplicateCase(caseId: string, resolution: string, notes: string): Promise<ApiResult<{ status: string }>> {
    try {
      const res = await this.rpc<{ ok: boolean; status?: string; error?: string; code?: string }>('fn_resolve_duplicate_case', {
        p_case_id: caseId, p_resolution: resolution, p_notes: notes,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Could not resolve the case.', code: res?.code }
      return { ok: true, data: { status: res.status as string } }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async mergePersons(keepId: string, mergeId: string, options: MergeOptions): Promise<ApiResult<{ message: string }>> {
    try {
      const res = await this.rpc<{ ok: boolean; message?: string; error?: string; code?: string }>('fn_merge_persons', {
        p_keep_id: keepId, p_merge_id: mergeId, p_resolved: options.resolved,
        p_reason: options.reason, p_confirm: options.confirm,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Merge failed.', code: res?.code }
      return { ok: true, data: { message: res.message ?? 'Records merged.' } }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  // ------------------------------------------------------------------ import
  async importCreateBatch(
    fileName: string, rows: PersonInput[], defaultBarangayId?: string | null,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ApiResult<{ batch_id: string }>> {
    try {
      // The first chunk creates the batch; the rest stream in. Chunks stay
      // small because the server scores every row against the registry
      // inside one statement — FIELD REPORT 2026-09-21: 400-row statements
      // hit the database statement timeout at ~1,000 rows ("canceling
      // statement due to statement timeout"). 60 rows stays well under it.
      const CHUNK = 60
      const first = rows.slice(0, CHUNK)
      const res = await this.rpc<{ ok: boolean; batch_id: string; error?: string }>('fn_import_create_batch', {
        p_file_name: fileName,
        p_mapping: { default_barangay_id: defaultBarangayId ?? null },
        p_rows: first,
      })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Could not create the import batch.' }
      onProgress?.(first.length, rows.length)
      for (let i = CHUNK; i < rows.length; i += CHUNK) {
        await this.rpc('fn_import_add_rows', { p_batch_id: res.batch_id, p_rows: rows.slice(i, i + CHUNK) })
        onProgress?.(Math.min(i + CHUNK, rows.length), rows.length)
      }
      return { ok: true, data: { batch_id: res.batch_id } }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async importSummary(batchId: string): Promise<ImportSummary | null> {
    const res = await this.rpc<ImportSummary>('fn_import_summary', { p_batch_id: batchId })
    return res ?? null
  }

  async importRows(batchId: string, filter?: { severity?: string; decision?: string; limit?: number; offset?: number }): Promise<ImportRow[]> {
    const res = await this.rpc<{ rows: ImportRow[] }>('fn_import_rows', {
      p_batch_id: batchId, p_severity: filter?.severity ?? null, p_decision: filter?.decision ?? null,
      p_limit: filter?.limit ?? 100, p_offset: filter?.offset ?? 0,
    })
    return res?.rows ?? []
  }

  async importSetDecision(rowId: string | number, decision: string): Promise<ApiResult<unknown>> {
    try {
      const res = await this.rpc<{ ok: boolean; error?: string }>('fn_import_set_decision', {
        p_row_id: Number(rowId), p_decision: decision,
      })
      return res?.ok ? { ok: true, data: res } : { ok: false, error: res?.error ?? 'Could not update the row.' }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async importSetAllDecisions(batchId: string, severity: string | null, decision: string): Promise<ApiResult<unknown>> {
    try {
      const res = await this.rpc<{ ok: boolean; updated?: number; error?: string }>('fn_import_set_all_decisions', {
        p_batch_id: batchId, p_severity: severity, p_decision: decision,
      })
      return res?.ok ? { ok: true, data: res } : { ok: false, error: res?.error ?? 'Could not update the rows.' }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async importCommit(batchId: string, defaultBarangayId?: string | null): Promise<ApiResult<{
    imported: number; duplicates_parked: number; skipped: number; linked: number; message: string
  }>> {
    try {
      const res = await this.rpc<{
        ok: boolean; imported?: number; duplicates_parked?: number; skipped?: number
        linked?: number; message?: string; error?: string
      }>('fn_import_commit', { p_batch_id: batchId, p_default_barangay: defaultBarangayId ?? null })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Import failed.' }
      return {
        ok: true,
        data: {
          imported: res.imported ?? 0, duplicates_parked: res.duplicates_parked ?? 0,
          skipped: res.skipped ?? 0, linked: res.linked ?? 0,
          message: res.message ?? 'Import committed.',
        },
      }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  async listImportBatches(): Promise<ImportSummary[]> {
    // Batches are listed through the audit trail to avoid an extra table scan.
    const res = await this.listAudit({ action: 'IMPORTED', limit: 50 })
    return res.rows.map((r) => ({
      batch_id: r.entity_id ?? r.id,
      file_name: r.entity_label ?? 'import',
      status: 'IMPORTED',
      created_at: r.timestamp,
      total_rows: 0, clean_rows: 0, warning_rows: 0, error_rows: 0, unique_rows: 0,
      duplicate_rows: 0, in_file_duplicates: 0, missing_birthdates: 0, invalid_dates: 0,
      missing_sex: 0, invalid_contacts: 0, missing_barangay: 0, approved_rows: 0,
      imported_rows: Number((r.new_values as { imported?: number } | null)?.imported ?? 0),
      issue_breakdown: {},
    }))
  }

  // ------------------------------------------------------------------ audit + users
  async listAudit(filters?: {
    query?: string; action?: string | null; entity?: string | null; user_id?: string | null
    from?: string | null; to?: string | null; limit?: number; offset?: number
  }): Promise<{ total: number; rows: AuditLogRow[] }> {
    const res = await this.rpc<{ total: number; rows: AuditLogRow[] }>('fn_list_audit', {
      p_query: filters?.query ?? '', p_action: filters?.action ?? null, p_entity: filters?.entity ?? null,
      p_user_id: filters?.user_id ?? null, p_from: filters?.from ?? null, p_to: filters?.to ?? null,
      p_limit: filters?.limit ?? 50, p_offset: filters?.offset ?? 0,
    })
    return { total: Number(res?.total ?? 0), rows: res?.rows ?? [] }
  }

  async logEvent(action: string, entityType: string, entityId?: string | null, label?: string | null,
    newValues?: unknown, reason?: string | null): Promise<void> {
    await this.rpc('fn_log_event', {
      p_action: action, p_entity_type: entityType, p_entity_id: entityId ?? null,
      p_entity_label: label ?? null, p_new_values: newValues ?? null, p_reason: reason ?? null,
    })
  }

  async listUsers(): Promise<ManagedUser[]> {
    return this.rpc<ManagedUser[]>('fn_list_users')
  }

  async upsertUser(input: Partial<ManagedUser> & { name: string; email: string; role: string }): Promise<ApiResult<ManagedUser>> {
    try {
      const res = await this.rpc<{ ok: boolean; user?: ManagedUser; error?: string }>('fn_upsert_user', { p: input })
      if (!res?.ok) return { ok: false, error: res?.error ?? 'Could not save the user.' }
      return { ok: true, data: res.user as ManagedUser }
    } catch (err) {
      const e = parseDbError(err)
      return { ok: false, error: e.message, code: e.code }
    }
  }

  // ------------------------------------------------------------------ offline sync surface
  pendingChanges(): OutboxItem[] {
    return []
  }

  async syncNow(): Promise<{ pushed: number; failed: number; conflicts: number }> {
    return { pushed: 0, failed: 0, conflicts: 0 }
  }

  async discardPending(): Promise<void> {
    /* not applicable in connected mode */
  }

  lastSyncedAt(): string | null {
    return new Date().toISOString()
  }
}
