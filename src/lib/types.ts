/** Shared domain types for NMBR. */

export type PersonStatus = 'ACTIVE' | 'INACTIVE' | 'TRANSFERRED' | 'DECEASED' | 'ARCHIVED' | 'FOR_REVIEW'
export type UserRole = 'ENCODER' | 'ADMINISTRATOR' | 'SYSTEM_ADMIN' | 'VIEWER'
export type DuplicateStatus = 'PENDING' | 'MERGED' | 'DIFFERENT_PERSON' | 'KEPT_BOTH' | 'DEFERRED' | 'DISMISSED'
export type TransferReason = 'RESIDENT_TRANSFER' | 'ADMINISTRATIVE_CORRECTION' | 'OTHER'

export const PERSON_STATUSES: PersonStatus[] = [
  'ACTIVE',
  'INACTIVE',
  'TRANSFERRED',
  'DECEASED',
  'FOR_REVIEW',
  'ARCHIVED',
]

export const ROLE_LABEL: Record<UserRole, string> = {
  ENCODER: 'Encoder',
  ADMINISTRATOR: 'Administrator',
  SYSTEM_ADMIN: 'System Administrator',
  VIEWER: 'Viewer (read-only)',
}

export interface Barangay {
  id: string
  name: string
  municipality: string
  province: string
  district?: string | null
  active: boolean
  created_at: string
  updated_at?: string | null
  /** aggregates computed by the server */
  total_members?: number
  active_members?: number
  new_today?: number
  possible_duplicates?: number
  for_review?: number
  last_updated?: string | null
}

export type SubsidyProgram = {
  id: string
  name: string
  description?: string | null
  period_start?: string | null
  period_end?: string | null
  active: boolean
  created_at?: string
  beneficiaries?: number
  verified?: number
}

export type SubsidyBeneficiary = {
  id: string
  program_id: string
  person_id: string
  barangay_id?: string | null
  classification_code?: string | null
  verified: boolean
  paper_ref?: string | null
  notes?: string | null
  created_at?: string
  person_name?: string
  reference_no?: string
  person_barangay?: string
  added_by_name?: string | null
}

/**
 * Neutral sector classifications for paper-list cross-checks. Deliberately
 * contains NO political or voting category: see docs/GO_LIVE.md §10.
 */
export const CLASSIFICATION_CODES: Array<{ code: string; label: string }> = [
  { code: '', label: 'No classification' },
  { code: '4PS', label: '4Ps beneficiary' },
  { code: 'SR', label: 'Senior citizen' },
  { code: 'PWD', label: 'Person with disability' },
  { code: 'SP', label: 'Solo parent' },
  { code: 'IND', label: 'Indigent — barangay-validated list' },
  { code: 'FW', label: 'Fisherman / farmer sector' },
]

export interface Person {
  id: string
  reference_no: string
  first_name: string
  middle_name: string | null
  last_name: string
  suffix: string | null
  date_of_birth: string | null
  sex: 'MALE' | 'FEMALE' | null
  civil_status: string | null
  contact_number: string | null
  address: string | null
  purok: string | null
  barangay_id: string | null
  barangay_name?: string | null
  status: PersonStatus
  remarks?: string | null
  classification_code?: string | null
  household_id?: string | null
  household_name?: string | null
  merged_into?: string | null
  merged_at?: string | null
  archived_at?: string | null
  created_at: string
  updated_at: string
  created_by?: string | null
  created_by_name?: string | null
  updated_by?: string | null
  updated_by_name?: string | null
  /** duplicates open on this record */
  open_duplicates?: number
}

/** Compact row used for search results, offline cache and duplicate pool. */
export interface PersonIndexRow {
  id: string
  reference_no: string
  first_name: string
  middle_name: string | null
  last_name: string
  suffix: string | null
  date_of_birth: string | null
  sex: string | null
  purok: string | null
  address: string | null
  contact_number: string | null
  barangay_id: string | null
  barangay_name: string | null
  status: PersonStatus
  updated_at: string
  identity_key?: string
}

export interface BarangayHistoryRow {
  id: string
  person_id: string
  barangay_id: string
  barangay_name: string
  effective_from: string
  effective_to: string | null
  status: string
  reason: TransferReason | null
  notes?: string | null
  created_at: string
  created_by_name?: string | null
}

export interface Household {
  id: string
  household_no: string
  barangay_id: string
  barangay_name?: string
  address: string | null
  purok: string | null
  head_person_id: string | null
  head_name?: string | null
  member_count?: number
  created_at: string
}

export interface AuditLogRow {
  id: string
  user_id: string | null
  user_name: string | null
  action: string
  entity_type: string
  entity_id: string | null
  entity_label?: string | null
  old_values: Record<string, unknown> | null
  new_values: Record<string, unknown> | null
  reason: string | null
  session_info: Record<string, unknown> | null
  timestamp: string
}

export interface DuplicateCase {
  id: string
  person_id_a: string
  person_id_b: string
  match_score: number
  match_band: string
  matching_fields: string[]
  matched_details?: unknown
  status: DuplicateStatus
  reviewed_by: string | null
  reviewed_by_name?: string | null
  reviewed_at: string | null
  resolution: string | null
  notes: string | null
  created_at: string
  created_by?: string | null
  person_a?: PersonIndexRow
  person_b?: PersonIndexRow
  batch_id?: string | null
  /** where the case came from: LIVE_CHECK, SAVE, IMPORT, MANUAL … */
  source?: string | null
}

export interface ManagedUser {
  id: string
  auth_user_id?: string | null
  name: string
  email: string
  role: UserRole
  active: boolean
  barangay_scope?: string | null
  created_at: string
  last_login: string | null
}

export interface SystemSettings {
  weights: Record<string, number>
  thresholds: Record<string, number>
  session_timeout_minutes: number
  mask_contact_in_lists: boolean
  block_on_very_likely: boolean
  require_reason_on_edit: boolean
  municipality: string
  province: string
  updated_at?: string
}

export interface DashboardStats {
  total_barangays: number
  active_barangays: number
  total_members: number
  active_members: number
  new_today: number
  updated_today: number
  possible_duplicates: number
  pending_duplicate_cases: number
  records_requiring_attention: number
  archived_records: number
  transferred_this_year?: number
  merged_records?: number
  last_sync_at: string | null
}

export interface DataQualityRow {
  id: string
  /** metric key returned by the server; falls back to `id` */
  metric?: string
  label: string
  description: string
  count: number
  severity: 'high' | 'medium' | 'low'
}

export type SyncStatus = 'PENDING' | 'SYNCING' | 'FAILED' | 'CONFLICT' | 'DONE'

export interface OutboxItem {
  id: string
  created_at: string
  operation: string
  payload: Record<string, unknown>
  summary: string
  status: SyncStatus
  attempts: number
  error?: string | null
  server_result?: Record<string, unknown> | null
}
