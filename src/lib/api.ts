/**
 * The single API contract used by the whole UI.
 *
 * Two implementations exist:
 *   • RemoteApi  — Supabase (PostgREST RPC): authoritative, server-enforced rules.
 *   • LocalApi   — IndexedDB/localStorage: identical behaviour for offline use.
 *
 * The UI never talks to a backend directly; it always goes through this
 * interface, so switching between "connected" and "offline" changes nothing in
 * the screens themselves.
 */
import type {
  AuditLogRow, Barangay, DataQualityRow, DuplicateCase, DashboardStats, Household, ManagedUser,
  OutboxItem, Person, PersonIndexRow, SystemSettings,
  SubsidyProgram, SubsidyBeneficiary,
} from './types'
import type { DuplicateMatch, PersonComparable } from './duplicateEngine'

export interface SessionUser {
  id: string
  name: string
  email: string
  role: 'ENCODER' | 'ADMINISTRATOR' | 'SYSTEM_ADMIN' | 'VIEWER'
  active: boolean
  barangay_scope?: string | null
  last_login?: string | null
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export type PersonInput = {
  first_name: string
  middle_name?: string | null
  last_name: string
  suffix?: string | null
  date_of_birth?: string | null
  sex?: string | null
  civil_status?: string | null
  contact_number?: string | null
  address?: string | null
  purok?: string | null
  barangay_id?: string | null
  status?: string | null
  remarks?: string | null
  classification_code?: string | null
  tags?: string[] | null
  occupation?: string | null
  /** paper-list family number; the server resolves or creates the household */
  household_no?: string | null
}

export type CreatePersonResult = {
  ok: boolean
  code?: string
  error?: string
  band?: string
  matches?: DuplicateMatch[]
  person?: Person
  queued?: boolean
}

export type SearchQuery = {
  query?: string
  barangay_id?: string | null
  status?: string | null
  sex?: string | null
  purok?: string | null
  /** Only records created on/after this local date (YYYY-MM-DD); powers the
   *  "New today" drill-down from the directory and dashboard cards. */
  created_since?: string | null
  duplicates_only?: boolean
  for_review_only?: boolean
  attention_only?: boolean
  attention?: string | null
  sort?: 'name' | 'updated' | 'barangay' | 'dob'
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export type SearchResult = { total: number; rows: Person[] }

export type ReportKind =
  | 'by_barangay' | 'by_sex' | 'by_age_group' | 'new_members' | 'transferred'
  | 'possible_duplicates' | 'resolved_duplicates' | 'data_quality' | 'encoder_activity' | 'audit_summary'

export interface PersonDetail extends Person {
  history: Array<{
    id: string; barangay_id: string; barangay_name: string; effective_from: string
    effective_to: string | null; status: string; reason: string | null
    notes?: string | null; created_at: string; created_by_name?: string | null
  }>
  household: Household | null
  duplicates: Array<{
    id: string; status: string; match_score: number; match_band: string
    matching_fields: string[]; matched_details?: unknown; created_at: string
    resolution?: string | null; notes?: string | null; reviewed_by_name?: string | null
    reviewed_at?: string | null; other_person: PersonIndexRow
  }>
  audit: AuditLogRow[]
  merged_from: PersonIndexRow[]
}

export interface DiffRow {
  field: string
  label: string
  a: unknown
  b: unknown
  same: boolean
}

export interface DuplicateComparison {
  score: number
  band: string
  reasons: Array<{ field: string; label: string; status: string; detail: string; similarity: number; weight: number }>
  flags: Record<string, unknown>
  a: Person
  b: Person
  diff: DiffRow[]
}

export interface ImportSummary {
  batch_id: string
  file_name: string
  status: string
  created_at: string
  total_rows: number
  clean_rows: number
  warning_rows: number
  error_rows: number
  unique_rows: number
  duplicate_rows: number
  in_file_duplicates: number
  missing_birthdates: number
  invalid_dates: number
  missing_sex: number
  invalid_contacts: number
  missing_barangay: number
  approved_rows: number
  imported_rows: number
  issue_breakdown: Record<string, number>
}

export interface ImportRow {
  id: string | number
  row_no: number
  raw: Record<string, unknown>
  normalized: PersonInput
  issues: string[]
  severity: 'OK' | 'WARNING' | 'ERROR'
  match_score: number | null
  band?: string | null
  decision: 'PENDING' | 'IMPORT' | 'SKIP' | 'LINK'
  match_person?: PersonIndexRow | null
  imported_person_id?: string | null
  in_file_of?: number | null
}

export interface MergeOptions {
  resolved: Record<string, string>
  reason: string
  confirm: boolean
}

export interface RegistryApi {
  readonly mode: 'local' | 'supabase'
  readonly offlineCapable: boolean

  // ---- session
  signIn(email: string, password: string): Promise<ApiResult<SessionUser>>
  signOut(): Promise<void>
  restoreSession(): Promise<SessionUser | null>
  touchSession(): void
  sessionExpired(): boolean

  // ---- reference data
  listBarangays(includeInactive?: boolean): Promise<Barangay[]>
  upsertBarangay(input: Partial<Barangay> & { name: string }): Promise<ApiResult<Barangay>>
  getSettings(): Promise<SystemSettings>
  saveSettings(patch: { weights?: unknown; thresholds?: unknown; system?: unknown }): Promise<ApiResult<SystemSettings>>

  // ---- registry reads
  dashboardStats(): Promise<DashboardStats>
  listSubsidyPrograms(): Promise<SubsidyProgram[]>
  upsertSubsidyProgram(input: Partial<SubsidyProgram> & { name: string }): Promise<ApiResult<SubsidyProgram>>
  listSubsidyBeneficiaries(programId: string, barangayId?: string | null): Promise<SubsidyBeneficiary[]>
  addSubsidyBeneficiary(input: {
    program_id: string; person_id: string; barangay_id?: string | null
    classification_code?: string | null; verified?: boolean; paper_ref?: string | null; notes?: string | null
  }): Promise<ApiResult<SubsidyBeneficiary>>
  removeSubsidyBeneficiary(id: string, reason?: string | null): Promise<ApiResult<{ id: string }>>
  searchPersons(query: SearchQuery): Promise<SearchResult>
  personIndex(): Promise<PersonIndexRow[]>
  getPerson(id: string): Promise<PersonDetail | null>
  checkDuplicates(candidate: PersonComparable, excludeId?: string | null): Promise<DuplicateMatch[]>
  bulkCheckDuplicates(rows: PersonInput[]): Promise<Array<{ index: number; matches: DuplicateMatch[] }>>
  dataQuality(): Promise<DataQualityRow[]>
  qualityRecords(metric: string, limit?: number): Promise<unknown[]>
  reports(kind: ReportKind, params?: { from?: string; to?: string; barangay_id?: string }): Promise<unknown>

  // ---- registry writes
  createPerson(input: PersonInput, opts?: { confirmedDistinct?: boolean; reason?: string }): Promise<CreatePersonResult>
  updatePerson(id: string, patch: Partial<PersonInput>, reason?: string): Promise<ApiResult<Person>>
  transferBarangay(input: {
    person_id: string; barangay_id: string; reason: string; effective_date?: string; notes?: string
  }): Promise<ApiResult<{ message: string }>>
  setPersonStatus(id: string, status: string, reason: string): Promise<ApiResult<Person>>

  // ---- duplicates
  listDuplicateCases(filters?: {
    status?: string; barangay_id?: string | null; min_score?: number | null
    query?: string; limit?: number; offset?: number
  }): Promise<{ total: number; rows: DuplicateCase[] }>
  comparePersons(a: string, b: string): Promise<DuplicateComparison | null>
  openDuplicateCase(a: string, b: string, source?: string, notes?: string): Promise<ApiResult<{ case_id: string }>>
  resolveDuplicateCase(caseId: string, resolution: string, notes: string): Promise<ApiResult<{ status: string }>>
  mergePersons(keepId: string, mergeId: string, options: MergeOptions): Promise<ApiResult<{ message: string }>>

  // ---- import
  importCreateBatch(fileName: string, rows: PersonInput[], defaultBarangayId?: string | null, onProgress?: (done: number, total: number) => void): Promise<ApiResult<{ batch_id: string; warning?: string }>>
  importSummary(batchId: string): Promise<ImportSummary | null>
  importRows(batchId: string, filter?: {
    severity?: string; decision?: string; limit?: number; offset?: number
  }): Promise<ImportRow[]>
  importSetDecision(rowId: string | number, decision: string): Promise<ApiResult<unknown>>
  importSetAllDecisions(batchId: string, severity: string | null, decision: string, duplicatesOnly?: boolean, onlyUndecided?: boolean): Promise<ApiResult<{ updated?: number }>>
  importCommit(batchId: string, defaultBarangayId?: string | null, onProgress?: (done: number) => void): Promise<ApiResult<{
    imported: number; duplicates_parked: number; skipped: number; linked: number; message: string
  }>>
  listImportBatches(): Promise<ImportSummary[]>

  // ---- audit + users
  listAudit(filters?: {
    query?: string; action?: string | null; entity?: string | null; user_id?: string | null
    from?: string | null; to?: string | null; limit?: number; offset?: number
  }): Promise<{ total: number; rows: AuditLogRow[] }>
  logEvent(action: string, entityType: string, entityId?: string | null, label?: string | null,
    newValues?: unknown, reason?: string | null): Promise<void>
  listUsers(): Promise<ManagedUser[]>
  upsertUser(input: Partial<ManagedUser> & { name: string; email: string; role: string }): Promise<ApiResult<ManagedUser>>

  // ---- offline synchronisation
  pendingChanges(): OutboxItem[]
  syncNow(): Promise<{ pushed: number; failed: number; conflicts: number }>
  discardPending(id: string): Promise<void>
  lastSyncedAt(): string | null
}
