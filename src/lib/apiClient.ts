/**
 * API CLIENT — the online/offline switch and the queued-change (outbox) engine.
 *
 * Rules:
 *  • Reads  : PostgreSQL when connected, otherwise the local mirror. Either way
 *             the UI gets the same shapes.
 *  • Writes : PostgreSQL when connected. If the connection drops mid-save (or the
 *             machine is offline) the change is applied to the local store and
 *             queued; the encoder keeps working and never loses an entry.
 *  • Nothing is ever silently discarded: a queued change that the server rejects
 *             (for example a duplicate that appeared in the meantime) is parked
 *             as a CONFLICT and shown in the Sync Centre for a human decision.
 */
import { LocalApi } from './localApi'
import { RemoteApi, RemoteError, isSchemaMissingError } from './remoteApi'
import { forgetOfflineCredential, rememberOfflineCredential } from './offlineCredential'
import { getConnectionState, getSupabase, probeConnection, watchConnectivity } from './supabase'
import type {
  ApiResult, CreatePersonResult, DuplicateComparison, ImportRow, ImportSummary, MergeOptions,
  PersonDetail, PersonInput, RegistryApi, ReportKind, SearchQuery, SearchResult, SessionUser,
} from './api'
import type {
  AuditLogRow, Barangay, DataQualityRow, DuplicateCase, DashboardStats, ManagedUser, OutboxItem,
  Person, PersonIndexRow, SystemSettings,
} from './types'
import type { DuplicateMatch, PersonComparable } from './duplicateEngine'

type Operation =
  | 'createPerson' | 'updatePerson' | 'transferBarangay' | 'setPersonStatus'
  | 'openDuplicateCase' | 'resolveDuplicateCase' | 'mergePersons'
  | 'upsertUser' | 'upsertBarangay' | 'saveSettings' | 'logEvent'

export type SyncEvent = {
  type: 'queued' | 'pushed' | 'conflict' | 'failed' | 'online' | 'offline' | 'mirrored'
  | 'provisioning' | 'not-provisioned' | 'auth-required'
  detail?: string
}

/** Deployment state of the central database, as far as the browser can tell. */
export type ServerStatus = 'unconfigured' | 'unknown' | 'ready' | 'missing'

/** Message shown on queued work while the database has not been deployed yet. */
export const WAITING_FOR_SETUP_MESSAGE =
  'Waiting for the municipal database to be set up. This change is safe on this device and will upload automatically afterwards.'

/**
 * Message shown on queued work while no municipal-server session is active.
 *
 * FIELD REPORT 2026-09-15: a device whose server sign-in had fallen back to the
 * on-device registry kept replaying its queue against the database every
 * minute. Every replay was refused with "Your session is not recognised" and
 * every refusal burned another retry (6, 24, 31, 46 attempts…), although no
 * number of retries can ever fix a missing sign-in. Authentication failures are
 * now recognised for what they are — a state, not an error — and the queue is
 * parked under this message until the person signs in, after which it uploads
 * by itself.
 */
export const WAITING_FOR_SIGNIN_MESSAGE =
  'Waiting for sign-in to the municipal server. This change is safe on this device and will upload automatically once you sign in.'

/** True when the failure means “the server answered but has no NMBR schema”. */
export function isProvisioningFailure(err: unknown): boolean {
  if (err instanceof RemoteError) return err.code === 'NOT_PROVISIONED'
  return isSchemaMissingError(err)
}

/**
 * True when the server answered “there is no session behind this request”.
 *
 * The guard triggers raise NMBR_UNAUTHENTICATED (errcode P0002) whenever the
 * JWT carries no linked, active profile; Supabase itself answers 401 when the
 * token is gone. Retrying cannot help — only a sign-in can — so the sync engine
 * parks the queue instead of burning retries against it.
 */
export function isAuthFailure(err: unknown): boolean {
  if (!err) return false
  const e = err as { code?: string; message?: string }
  const code = String(e.code ?? '')
  if (code === 'P0002' || code === '401' || code === 'UNAUTHENTICATED') return true
  const text = `${e.message ?? ''} ${err instanceof Error ? err.message : String(err)}`
  return /NMBR_UNAUTHENTICATED|session is not recognised|not authenticated|invalid token|jwt expired|session expired|re-authentication required/i.test(text)
}

export class ApiClient implements RegistryApi {
  readonly local: LocalApi
  readonly remote: RemoteApi | null
  private listeners = new Set<(e: SyncEvent) => void>()
  private syncing = false
  private sessionSource: 'remote' | 'local' = 'local'
  /** Set when a sign-in fell back to the local registry; read by the sign-in screen. */
  signInNotice: string | null = null
  /** null = not checked yet; false = Supabase reachable but the schema is absent. */
  private provisioned: boolean | null = null
  private provisioningCheckedAt = 0
  /**
   * Set when the server refused queued work because no session is active.
   * While it is set the queue is parked (no retries are burned) and the UI asks
   * for a sign-in; a successful server sign-in clears it and flushes the queue.
   */
  private authBlocked = false

  /**
   * @param options.remote inject a specific backend (used by the tests to
   *   reproduce a Supabase project that has not been set up yet). Omit it in the
   *   application: the client is then built from the configured Supabase project.
   */
  constructor(options?: { remote?: RemoteApi | null }) {
    this.local = new LocalApi()
    let remote: RemoteApi | null = null
    if (options && 'remote' in options) {
      remote = options.remote ?? null
    } else {
      try {
        remote = getSupabase() ? new RemoteApi() : null
      } catch {
        remote = null
      }
    }
    this.remote = remote
    watchConnectivity()
    if (remote) void probeConnection()
  }

  // ------------------------------------------------------------------ plumbing
  get mode(): 'local' | 'supabase' {
    return this.remote ? 'supabase' : 'local'
  }

  get offlineCapable(): boolean {
    return true
  }

  get online(): boolean {
    return !!this.remote && getConnectionState() !== 'offline' && navigator.onLine
  }

  /**
   * True when reads and writes are currently being served by PostgreSQL.
   *
   * When the deployed server has no NMBR schema yet, this stays false so that
   * every write is applied locally and queued instead of being fired at a
   * database that cannot accept it.
   */
  get usingServer(): boolean {
    return !!this.remote && this.online && this.sessionSource === 'remote' && this.provisioned !== false
  }

  /**
   * True when queued work is parked because the municipal server has no active
   * session from this device. The queue uploads by itself after a sign-in.
   */
  get needsSignIn(): boolean {
    return this.authBlocked
  }

  /** Deployment state of the central database, for the Sync Centre and Settings. */
  get serverStatus(): ServerStatus {
    if (!this.remote) return 'unconfigured'
    if (this.provisioned === true) return 'ready'
    if (this.provisioned === false) return 'missing'
    return 'unknown'
  }

  /**
   * Ask the server whether the NMBR schema is deployed.
   * Cached for a short while so ordinary traffic does not re-probe constantly.
   */
  async checkServer(maxAgeMs = 60_000): Promise<ServerStatus> {
    if (!this.remote || !navigator.onLine) return this.serverStatus
    if (this.provisioned !== null && Date.now() - this.provisioningCheckedAt < maxAgeMs) return this.serverStatus
    const result = await this.remote.probeSchema()
    this.provisioningCheckedAt = Date.now()
    if (result === 'ready') {
      this.provisioned = true
      this.emit({ type: 'provisioning', detail: 'Municipal server ready' })
      return 'ready'
    }
    if (result === 'missing') {
      const wasUnknown = this.provisioned !== false
      this.provisioned = false
      if (wasUnknown) {
        this.emit({
          type: 'not-provisioned',
          detail: 'The municipal server is reachable but the NMBR tables and functions have not been created yet.',
        })
      }
      return 'missing'
    }
    return this.serverStatus
  }

  onEvent(fn: (e: SyncEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: SyncEvent) {
    this.listeners.forEach((l) => l(e))
  }

  private queue(operation: Operation, payload: Record<string, unknown>, summary: string) {
    this.local.queueOutbox({ operation, payload, summary })
    this.emit({ type: 'queued', detail: summary })
  }

  /** Writes: server when possible, otherwise local + outbox. */
  private async write<T>(
    operation: Operation,
    payload: Record<string, unknown>,
    summary: string,
    localFn: () => Promise<ApiResult<T>>,
    remoteFn: (() => Promise<ApiResult<T>>) | null,
  ): Promise<ApiResult<T>> {
    if (remoteFn && this.usingServer) {
      const res = await remoteFn()
      if (res.ok) return res
      const code = (res as { code?: string }).code
      const networkFailure = code === 'NETWORK' || /failed to fetch|network|timeout/i.test(res.error ?? '')
      // A dead session is like a dropped link for the person at the desk: the
      // entry is kept on the device and uploaded after signing in again,
      // instead of being bounced back as a hard error.
      if (networkFailure || isAuthFailure(res)) {
        if (isAuthFailure(res)) this.blockForSignIn()
        const localRes = await localFn()
        if (localRes.ok) {
          this.queue(operation, payload, summary)
          return localRes
        }
        return localRes
      }
      return res
    }
    const localRes = await localFn()
    if (localRes.ok) this.queue(operation, payload, summary)
    return localRes
  }

  /** Reads: server when possible (and mirrors the result), otherwise local. */
  private async read<T>(remoteFn: (() => Promise<T>) | null, localFn: () => Promise<T>): Promise<T> {
    if (remoteFn && this.usingServer) {
      try {
        return await remoteFn()
      } catch {
        return await localFn()
      }
    }
    return await localFn()
  }

  // ------------------------------------------------------------------ session
  /**
   * Try the municipal server first, then fall back to the on-device registry.
   *
   * The fallback matters for a freshly installed copy: until the PostgreSQL
   * functions are deployed (or while the office link is down) staff must still be
   * able to sign in and encode. The fallback is never silent — `signInNotice`
   * carries the reason so the screen can tell the user which registry they are on.
   */
  async signIn(email: string, password: string): Promise<ApiResult<SessionUser>> {
    this.signInNotice = null
    let remoteFailure: ApiResult<SessionUser> | null = null

    if (this.remote && navigator.onLine) {
      const res = await this.remote.signIn(email, password)
      if (res.ok) {
        this.sessionSource = 'remote'
        this.remote.setSession(res.data)
        localStorage.setItem('nmbr.session.source', 'remote')
        this.provisioned = true
        this.provisioningCheckedAt = Date.now()
        // A fresh server session releases anything the queue was holding for:
        // parked work uploads right away, without waiting for the next timer.
        const hadParkedWork = this.authBlocked || this.local.outboxSnapshot().some((o) => o.status !== 'DONE')
        this.authBlocked = false
        this.emit({ type: 'online', detail: 'Signed in to the municipal server' })
        void this.refreshMirror()
        if (hadParkedWork) void this.syncNow()
        rememberOfflineCredential(res.data, password)
        return res
      }
      if (res.code !== 'OFFLINE') remoteFailure = res
      if (remoteFailure && /deactivated|not registered/i.test(remoteFailure.error ?? '')) {
        forgetOfflineCredential(email)
      }
    }

    const localRes = await this.local.signIn(email, password)
    if (localRes.ok) {
      this.sessionSource = 'local'
      localStorage.setItem('nmbr.session.source', 'local')
      if (remoteFailure) {
        this.signInNotice =
          'Signed in to the on-device registry copy. The municipal server did not accept the sign-in' +
          ` (${remoteFailure.error}). Deploy the database functions or check the office link to work online.`
      }
      return localRes
    }
    return remoteFailure ?? localRes
  }

  async signOut(): Promise<void> {
    if (this.sessionSource === 'remote' && this.remote) await this.remote.signOut()
    await this.local.signOut()
    this.sessionSource = 'local'
    localStorage.removeItem('nmbr.session.source')
  }

  async restoreSession(): Promise<SessionUser | null> {
    const cachedSource = localStorage.getItem('nmbr.session.source')
    if (this.remote && cachedSource === 'remote' && navigator.onLine) {
      const user = await this.remote.restoreSession()
      if (user) {
        this.sessionSource = 'remote'
        this.authBlocked = false
        void this.refreshMirror()
        return user
      }
    }
    const local = await this.local.restoreSession()
    if (local) {
      this.sessionSource = 'local'
      return local
    }
    if (this.remote && cachedSource === 'remote') {
      const user = await this.remote.restoreSession().catch(() => null)
      if (user) {
        this.sessionSource = 'remote'
        return user
      }
    }
    return null
  }

  touchSession(): void {
    this.local.touchSession()
    this.remote?.touchSession()
  }

  sessionExpired(): boolean {
    return this.sessionSource === 'remote' ? (this.remote?.sessionExpired() ?? true) : this.local.sessionExpired()
  }

  getSessionUser(): SessionUser | null {
    return this.sessionSource === 'remote' ? this.remote?.getSession() ?? null : this.local.getSession()
  }

  /** Pull a compact mirror of the registry so the office can keep working offline. */
  async refreshMirror(): Promise<void> {
    if (!this.remote || !this.usingServer) return
    try {
      const [persons, barangays, cases] = await Promise.all([
        this.remote.personIndex(),
        this.remote.listBarangays(true),
        this.remote.listDuplicateCases({ status: 'PENDING', limit: 200 }).then((r) => r.rows).catch(() => []),
      ])
      const mirror = (persons ?? []).map((p) => ({
        id: p.id, reference_no: p.reference_no, first_name: p.first_name, middle_name: p.middle_name,
        last_name: p.last_name, suffix: p.suffix, date_of_birth: p.date_of_birth, sex: p.sex,
        civil_status: null, contact_number: p.contact_number, address: p.address, purok: p.purok,
        barangay_id: p.barangay_id, barangay_name: p.barangay_name, status: p.status, remarks: null,
        household_id: null, created_at: p.updated_at, updated_at: p.updated_at,
      })) as Person[]
      this.local.replaceMirror({ persons: mirror, barangays })
      const existingCases = await this.local.listDuplicateCases({ status: 'ALL', limit: 200 })
      if (existingCases.total === 0 && cases.length) {
        for (const c of cases) {
          await this.local.openDuplicateCase(c.person_id_a, c.person_id_b, c.source ?? 'LIVE_CHECK', c.notes ?? undefined)
        }
      }
      this.local.setLastSync(new Date().toISOString())
      this.emit({ type: 'mirrored', detail: `${mirror.length} records cached for offline use` })
    } catch {
      /* mirroring is best-effort */
    }
  }

  // ------------------------------------------------------------------ reference (reads)
  listBarangays(includeInactive = false): Promise<Barangay[]> {
    return this.read(
      this.remote ? () => this.remote!.listBarangays(includeInactive) : null,
      () => this.local.listBarangays(includeInactive),
    )
  }

  getSettings(): Promise<SystemSettings> {
    return this.read(this.remote ? () => this.remote!.getSettings() : null, () => this.local.getSettings())
  }

  dashboardStats(): Promise<DashboardStats> {
    return this.read(this.remote ? () => this.remote!.dashboardStats() : null, () => this.local.dashboardStats())
  }

  searchPersons(query: SearchQuery): Promise<SearchResult> {
    return this.read(this.remote ? () => this.remote!.searchPersons(query) : null, () => this.local.searchPersons(query))
  }

  personIndex(): Promise<PersonIndexRow[]> {
    return this.read(this.remote ? () => this.remote!.personIndex() : null, () => this.local.personIndex())
  }

  getPerson(id: string): Promise<PersonDetail | null> {
    return this.read(this.remote ? () => this.remote!.getPerson(id) : null, () => this.local.getPerson(id))
  }

  checkDuplicates(candidate: PersonComparable, excludeId?: string | null): Promise<DuplicateMatch[]> {
    // Duplicate checking must always answer instantly, even with a slow link:
    // the local engine runs first and the server result (authoritative) replaces it.
    return this.read(
      this.remote && this.usingServer ? () => this.remote!.checkDuplicates(candidate, excludeId) : null,
      () => this.local.checkDuplicates(candidate, excludeId),
    )
  }

  bulkCheckDuplicates(rows: PersonInput[]): Promise<Array<{ index: number; matches: DuplicateMatch[] }>> {
    return this.read(
      this.remote ? () => this.remote!.bulkCheckDuplicates(rows) : null,
      () => this.local.bulkCheckDuplicates(rows),
    )
  }

  dataQuality(): Promise<DataQualityRow[]> {
    return this.read(this.remote ? () => this.remote!.dataQuality() : null, () => this.local.dataQuality())
  }

  qualityRecords(metric: string, limit = 100): Promise<unknown[]> {
    return this.read(
      this.remote ? () => this.remote!.qualityRecords(metric, limit) : null,
      () => this.local.qualityRecords(metric, limit),
    )
  }

  reports(kind: ReportKind, params?: { from?: string; to?: string; barangay_id?: string }): Promise<unknown> {
    return this.read(
      this.remote ? () => this.remote!.reports(kind, params) : null,
      () => this.local.reports(kind, params),
    )
  }

  listDuplicateCases(filters?: {
    status?: string; barangay_id?: string | null; min_score?: number | null
    query?: string; limit?: number; offset?: number
  }): Promise<{ total: number; rows: DuplicateCase[] }> {
    return this.read(
      this.remote ? () => this.remote!.listDuplicateCases(filters) : null,
      () => this.local.listDuplicateCases(filters),
    )
  }

  comparePersons(a: string, b: string): Promise<DuplicateComparison | null> {
    return this.read(
      this.remote ? () => this.remote!.comparePersons(a, b) : null,
      () => this.local.comparePersons(a, b),
    )
  }

  listAudit(filters?: {
    query?: string; action?: string | null; entity?: string | null; user_id?: string | null
    from?: string | null; to?: string | null; limit?: number; offset?: number
  }): Promise<{ total: number; rows: AuditLogRow[] }> {
    return this.read(
      this.remote ? () => this.remote!.listAudit(filters) : null,
      () => this.local.listAudit(filters),
    )
  }

  listUsers(): Promise<ManagedUser[]> {
    return this.read(this.remote ? () => this.remote!.listUsers() : null, () => this.local.listUsers())
  }

  // ------------------------------------------------------------------ writes
  createPerson(input: PersonInput, opts?: { confirmedDistinct?: boolean; reason?: string }): Promise<CreatePersonResult> {
    const clientRef = crypto.randomUUID()
    const payload = { ...input, client_ref: clientRef }
    return this.writeRemoteFirst(
      'createPerson',
      { input: payload, local_id: clientRef, confirmedDistinct: opts?.confirmedDistinct, reason: opts?.reason },
      `Add member: ${input.first_name} ${input.last_name}`,
      () => this.local.createPerson({ ...input, client_ref: clientRef } as PersonInput, opts),
      this.remote
        ? async () => {
            const res = await this.remote!.createPerson(payload as PersonInput, opts)
            if (!res.ok) return res
            return res
          }
        : null,
      clientRef,
    )
  }

  private async writeRemoteFirst<T extends { ok: boolean }>(
    operation: Operation,
    payload: Record<string, unknown>,
    summary: string,
    localFn: () => Promise<T>,
    remoteFn: (() => Promise<T>) | null,
    clientRef?: string,
  ): Promise<T> {
    if (remoteFn && this.usingServer) {
      const remoteRes = await remoteFn()
      if (remoteRes.ok) return remoteRes
      const code = (remoteRes as { code?: string }).code
      if (code === 'DUPLICATE_REVIEW_REQUIRED') return remoteRes
      // A refused session must not swallow the entry: keep it on the device
      // and let the person sign in again — the queue then uploads by itself.
      if (isAuthFailure(remoteRes)) {
        this.blockForSignIn()
        const localRes = await localFn()
        if ((localRes as { ok: boolean }).ok) {
          this.queue(operation, { ...payload, local_id: clientRef }, summary)
        }
        return localRes
      }
      if (code && !/NETWORK/i.test(code)) return remoteRes
    }
    const localRes = await localFn()
    if ((localRes as { ok: boolean }).ok) {
      this.queue(operation, { ...payload, local_id: clientRef }, summary)
    }
    return localRes
  }

  updatePerson(id: string, patch: Partial<PersonInput>, reason?: string): Promise<ApiResult<Person>> {
    return this.write(
      'updatePerson', { id, patch, reason }, `Update member record`,
      () => this.local.updatePerson(id, patch, reason),
      this.remote ? () => this.remote!.updatePerson(id, patch, reason) : null,
    )
  }

  transferBarangay(input: {
    person_id: string; barangay_id: string; reason: string; effective_date?: string; notes?: string
  }): Promise<ApiResult<{ message: string }>> {
    return this.write(
      'transferBarangay', { ...input },
      `Transfer member to another barangay`,
      () => this.local.transferBarangay(input),
      this.remote ? () => this.remote!.transferBarangay(input) : null,
    )
  }

  setPersonStatus(id: string, status: string, reason: string): Promise<ApiResult<Person>> {
    return this.write(
      'setPersonStatus', { id, status, reason }, `Set member status to ${status}`,
      () => this.local.setPersonStatus(id, status, reason),
      this.remote ? () => this.remote!.setPersonStatus(id, status, reason) : null,
    )
  }

  openDuplicateCase(a: string, b: string, source = 'MANUAL', notes?: string): Promise<ApiResult<{ case_id: string }>> {
    return this.write(
      'openDuplicateCase', { a, b, source, notes }, 'Flag a possible duplicate',
      () => this.local.openDuplicateCase(a, b, source, notes),
      this.remote ? () => this.remote!.openDuplicateCase(a, b, source, notes) : null,
    )
  }

  resolveDuplicateCase(caseId: string, resolution: string, notes: string): Promise<ApiResult<{ status: string }>> {
    return this.write(
      'resolveDuplicateCase', { caseId, resolution, notes }, `Duplicate decision: ${resolution}`,
      () => this.local.resolveDuplicateCase(caseId, resolution, notes),
      this.remote ? () => this.remote!.resolveDuplicateCase(caseId, resolution, notes) : null,
    )
  }

  mergePersons(keepId: string, mergeId: string, options: MergeOptions): Promise<ApiResult<{ message: string }>> {
    return this.write(
      'mergePersons', { keepId, mergeId, options }, 'Merge duplicate records',
      () => this.local.mergePersons(keepId, mergeId, options),
      this.remote ? () => this.remote!.mergePersons(keepId, mergeId, options) : null,
    )
  }

  upsertUser(input: Partial<ManagedUser> & { name: string; email: string; role: string }): Promise<ApiResult<ManagedUser>> {
    return this.write(
      'upsertUser', { input }, `Save user ${input.email}`,
      () => this.local.upsertUser(input),
      this.remote ? () => this.remote!.upsertUser(input) : null,
    )
  }

  upsertBarangay(input: Partial<Barangay> & { name: string }): Promise<ApiResult<Barangay>> {
    return this.write(
      'upsertBarangay', { input }, `Save barangay ${input.name}`,
      () => this.local.upsertBarangay(input),
      this.remote ? () => this.remote!.upsertBarangay(input) : null,
    )
  }

  saveSettings(patch: { weights?: unknown; thresholds?: unknown; system?: unknown }): Promise<ApiResult<SystemSettings>> {
    return this.write(
      'saveSettings', { patch }, 'Update duplicate detection rules',
      () => this.local.saveSettings(patch),
      this.remote ? () => this.remote!.saveSettings(patch) : null,
    )
  }

  async logEvent(action: string, entityType: string, entityId?: string | null, label?: string | null,
    newValues?: unknown, reason?: string | null): Promise<void> {
    await this.local.logEvent(action, entityType, entityId, label, newValues, reason)
    if (this.usingServer && this.remote) {
      try {
        await this.remote.logEvent(action, entityType, entityId, label, newValues, reason)
      } catch {
        this.queue('logEvent', { action, entityType, entityId, label, newValues, reason }, `${action} ${label ?? ''}`)
      }
    }
  }

  // ------------------------------------------------------------------ import
  importCreateBatch(fileName: string, rows: PersonInput[], defaultBarangayId?: string | null): Promise<ApiResult<{ batch_id: string }>> {
    return this.read(
      this.remote && this.usingServer
        ? () => this.remote!.importCreateBatch(fileName, rows, defaultBarangayId)
        : null,
      () => this.local.importCreateBatch(fileName, rows, defaultBarangayId),
    )
  }

  importSummary(batchId: string): Promise<ImportSummary | null> {
    if (this.usingServer && this.remote && !batchId.startsWith('ib')) return this.remote.importSummary(batchId)
    return this.local.importSummary(batchId)
  }

  importRows(batchId: string, filter?: { severity?: string; decision?: string; limit?: number; offset?: number }): Promise<ImportRow[]> {
    if (this.usingServer && this.remote && !batchId.startsWith('ib')) return this.remote.importRows(batchId, filter)
    return this.local.importRows(batchId, filter)
  }

  importSetDecision(rowId: string | number, decision: string): Promise<ApiResult<unknown>> {
    if (this.usingServer && this.remote && !String(rowId).startsWith('ib')) {
      return this.remote.importSetDecision(rowId, decision)
    }
    return this.local.importSetDecision(rowId, decision)
  }

  importSetAllDecisions(batchId: string, severity: string | null, decision: string): Promise<ApiResult<unknown>> {
    if (this.usingServer && this.remote && !batchId.startsWith('ib')) {
      return this.remote.importSetAllDecisions(batchId, severity, decision)
    }
    return this.local.importSetAllDecisions(batchId, severity, decision)
  }

  importCommit(batchId: string, defaultBarangayId?: string | null): Promise<ApiResult<{
    imported: number; duplicates_parked: number; skipped: number; linked: number; message: string
  }>> {
    if (this.usingServer && this.remote && !batchId.startsWith('ib')) {
      return this.remote.importCommit(batchId, defaultBarangayId)
    }
    return this.local.importCommit(batchId, defaultBarangayId)
  }

  listImportBatches(): Promise<ImportSummary[]> {
    return this.read(
      this.remote && this.usingServer ? () => this.remote!.listImportBatches() : null,
      () => this.local.listImportBatches(),
    )
  }

  // ------------------------------------------------------------------ sync
  pendingChanges(): OutboxItem[] {
    return this.local.outboxSnapshot()
  }

  /**
   * Replay the queue against the municipal server.
   *
   * Three outcomes are distinguished, because they mean very different things to
   * the person at the desk:
   *   • pushed    — the change reached PostgreSQL
   *   • conflict  — the server refused it because of a duplicate; a human decides
   *   • waiting   — the server has no NMBR schema yet (setup not run). The change
   *                 stays queued and is retried automatically once it is set up.
   *                 It is NOT counted as a failure and does not burn retries.
   */
  async syncNow(): Promise<{ pushed: number; failed: number; conflicts: number }> {
    if (!this.remote || this.syncing) return { pushed: 0, failed: 0, conflicts: 0 }
    // A parked queue waits for a person, not for a timer: replaying it against
    // a server that has no session from this device would only burn retries
    // (field report: 46 attempts against "Your session is not recognised").
    if (this.authBlocked) return { pushed: 0, failed: 0, conflicts: 0 }
    if (!(await this.serverReachable())) return { pushed: 0, failed: 0, conflicts: 0 }

    const serverStatus = await this.checkServer()
    if (serverStatus === 'missing') {
      this.parkQueueForSetup()
      return { pushed: 0, failed: 0, conflicts: 0 }
    }

    this.syncing = true
    let pushed = 0
    let failed = 0
    let conflicts = 0
    let provisioningStopped = false
    try {
      for (const item of this.local.outboxSnapshot().filter((o) => o.status === 'PENDING' || o.status === 'FAILED')) {
        // Remember the count before bumping it: the outbox snapshot shares its
        // objects with the store, so `item.attempts` moves as soon as the row
        // is marked SYNCING — a parked refusal must hand the count back.
        const priorAttempts = item.attempts
        this.local.updateOutbox(item.id, { status: 'SYNCING', attempts: priorAttempts + 1 })
        try {
          const result = await this.replay(item)
          if (result === 'conflict') {
            conflicts++
            this.local.updateOutbox(item.id, {
              status: 'CONFLICT', error: 'The server found a possible duplicate while replaying this change.',
            })
            this.emit({ type: 'conflict', detail: item.summary })
          } else if (result === 'ok') {
            pushed++
            this.local.updateOutbox(item.id, { status: 'DONE' })
            this.emit({ type: 'pushed', detail: item.summary })
          }
        } catch (err) {
          if (isProvisioningFailure(err)) {
            // The database is not deployed. Stop hammering it: put this item and
            // everything after it back in the waiting state.
            this.provisioned = false
            this.provisioningCheckedAt = Date.now()
            provisioningStopped = true
            this.local.updateOutbox(item.id, { status: 'PENDING', error: WAITING_FOR_SETUP_MESSAGE })
            this.emit({
              type: 'not-provisioned',
              detail: 'The municipal database has not been set up yet, so queued work is waiting.',
            })
            break
          }
          if (isAuthFailure(err)) {
            // The server is fine — it simply has no session from this device.
            // No amount of retrying can change that, so park this item and
            // everything after it (undoing the attempt just counted) and ask
            // the person to sign in; the queue flushes itself afterwards.
            this.local.updateOutbox(item.id, {
              status: 'PENDING', error: WAITING_FOR_SIGNIN_MESSAGE, attempts: priorAttempts,
            })
            this.blockForSignIn()
            break
          }
          failed++
          const message = err instanceof Error ? err.message : String(err)
          this.local.updateOutbox(item.id, { status: 'FAILED', error: message })
          this.emit({ type: 'failed', detail: `${item.summary}: ${message}` })
        }
      }

      if (provisioningStopped) this.parkQueueForSetup()
      // drop completed items, keep failures/conflicts/waiting for review
      const remaining = this.local.outboxSnapshot().filter((o) => o.status !== 'DONE')
      this.local.setOutbox(remaining)
      this.local.setLastSync(new Date().toISOString())
      await this.refreshMirror()
    } finally {
      this.syncing = false
    }
    return { pushed, failed, conflicts }
  }

  /**
   * Keep every outstanding change on the device, flagged as waiting for the
   * database setup rather than failed. Retry counts are left untouched so the
   * queue is not worn down while the administrator prepares the server.
   */
  private parkQueueForSetup() {
    const outstanding = this.local
      .outboxSnapshot()
      .filter((o) => o.status !== 'DONE' && o.status !== 'CONFLICT')
    if (outstanding.length === 0) return
    this.local.setOutbox(
      outstanding.map((o) => ({ ...o, status: 'PENDING' as const, error: WAITING_FOR_SETUP_MESSAGE })),
    )
    this.emit({ type: 'not-provisioned', detail: `${outstanding.length} change(s) waiting for the database setup` })
  }

  /** Mark the queue as waiting for a sign-in and tell the UI about it. */
  private blockForSignIn() {
    const firstBlock = !this.authBlocked
    this.authBlocked = true
    this.parkQueueForSignIn()
    if (firstBlock) {
      this.emit({
        type: 'auth-required',
        detail: 'The municipal server needs you to sign in again before queued work can upload.',
      })
    }
  }

  /**
   * Keep every outstanding change on the device, flagged as waiting for a
   * sign-in rather than failed. Retry counts are left untouched: a missing
   * session is not the queue's fault and must not wear it down.
   */
  private parkQueueForSignIn() {
    const outstanding = this.local
      .outboxSnapshot()
      .filter((o) => o.status !== 'DONE' && o.status !== 'CONFLICT')
    if (outstanding.length === 0) return
    this.local.setOutbox(
      outstanding.map((o) => ({ ...o, status: 'PENDING' as const, error: WAITING_FOR_SIGNIN_MESSAGE })),
    )
  }

  /**
   * Release a sign-in block without signing in (for example after the session
   * could be restored from another tab); the next sync re-proves the session.
   */
  releaseSignInBlock(): void {
    this.authBlocked = false
  }

  /**
   * Can the central database be talked to at all?
   *
   * `probeConnection()` answers this from the compiled-in project settings. When
   * no project is compiled in but a client exists anyway (an injected one, as in
   * the tests) the schema probe is the better judge: it reports 'unknown' when
   * the network is down and 'missing'/'ready' when something answered.
   */
  private async serverReachable(): Promise<boolean> {
    const state = await probeConnection()
    if (state === 'online') return true
    if (state === 'unconfigured' && this.remote) {
      const status = await this.checkServer()
      return status === 'ready' || status === 'missing'
    }
    return false
  }

  /** Force a fresh provisioning check (used by the “check again” buttons). */
  async recheckServer(): Promise<ServerStatus> {
    this.provisioned = null
    this.provisioningCheckedAt = 0
    return this.checkServer(0)
  }

  private async replay(item: OutboxItem): Promise<'ok' | 'conflict'> {
    const remote = this.remote!
    const p = item.payload as Record<string, never>
    switch (item.operation as Operation) {
      case 'createPerson': {
        const res = await remote.createPerson(p.input as unknown as PersonInput, {
          confirmedDistinct: Boolean(p.confirmedDistinct), reason: (p.reason as string) ?? undefined,
        })
        if (res.ok && res.person) {
          const localId = item.payload.local_id as string
          if (localId) this.local.remapPersonId(localId, res.person.id)
          return 'ok'
        }
        if (res.code === 'DUPLICATE_REVIEW_REQUIRED') return 'conflict'
        throw new Error(res.error ?? 'Server rejected the record')
      }
      case 'updatePerson': {
        const res = await remote.updatePerson(p.id as unknown as string, p.patch as never, p.reason as string)
        if (!res.ok) {
          if (res.code === 'DUPLICATE_REVIEW_REQUIRED') return 'conflict'
          throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        }
        return 'ok'
      }
      case 'transferBarangay': {
        const res = await remote.transferBarangay(p as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'setPersonStatus': {
        const res = await remote.setPersonStatus(p.id as never, p.status as never, p.reason as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'openDuplicateCase': {
        const res = await remote.openDuplicateCase(p.a as never, p.b as never, p.source as never, p.notes as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'resolveDuplicateCase': {
        const res = await remote.resolveDuplicateCase(p.caseId as never, p.resolution as never, p.notes as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'mergePersons': {
        const res = await remote.mergePersons(p.keepId as never, p.mergeId as never, p.options as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'upsertUser': {
        const res = await remote.upsertUser(p.input as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'upsertBarangay': {
        const res = await remote.upsertBarangay(p.input as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'saveSettings': {
        const res = await remote.saveSettings(p.patch as never)
        if (!res.ok) throw new RemoteError(res.error ?? 'The server rejected this change.', (res as { code?: string }).code)
        return 'ok'
      }
      case 'logEvent': {
        await remote.logEvent(p.action as never, p.entityType as never, p.entityId as never, p.label as never,
          p.newValues, p.reason as never)
        return 'ok'
      }
      default:
        throw new Error(`Unknown queued operation: ${item.operation}`)
    }
  }

  async discardPending(id: string): Promise<void> {
    await this.local.discardPending(id)
  }

  lastSyncedAt(): string | null {
    return this.local.lastSyncedAt()
  }
}

let singleton: ApiClient | null = null

export function getApi(): ApiClient {
  if (!singleton) singleton = new ApiClient()
  return singleton
}
