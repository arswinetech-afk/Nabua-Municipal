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
import { RemoteApi } from './remoteApi'
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
  detail?: string
}

export class ApiClient implements RegistryApi {
  readonly local: LocalApi
  readonly remote: RemoteApi | null
  private listeners = new Set<(e: SyncEvent) => void>()
  private syncing = false
  private sessionSource: 'remote' | 'local' = 'local'
  /** Set when a sign-in fell back to the local registry; read by the sign-in screen. */
  signInNotice: string | null = null

  constructor() {
    this.local = new LocalApi()
    let remote: RemoteApi | null = null
    try {
      remote = getSupabase() ? new RemoteApi() : null
    } catch {
      remote = null
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

  /** True when reads/writes are currently being served by PostgreSQL. */
  get usingServer(): boolean {
    return !!this.remote && this.online && this.sessionSource === 'remote'
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
      if (networkFailure) {
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
        void this.refreshMirror()
        return res
      }
      if (res.code !== 'OFFLINE') remoteFailure = res
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

  async syncNow(): Promise<{ pushed: number; failed: number; conflicts: number }> {
    if (!this.remote || this.syncing) return { pushed: 0, failed: 0, conflicts: 0 }
    const state = await probeConnection()
    if (state !== 'online') return { pushed: 0, failed: 0, conflicts: 0 }
    this.syncing = true
    let pushed = 0
    let failed = 0
    let conflicts = 0
    try {
      for (const item of this.local.outboxSnapshot().filter((o) => o.status === 'PENDING' || o.status === 'FAILED')) {
        this.local.updateOutbox(item.id, { status: 'SYNCING', attempts: item.attempts + 1 })
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
          failed++
          const message = err instanceof Error ? err.message : String(err)
          this.local.updateOutbox(item.id, { status: 'FAILED', error: message })
          this.emit({ type: 'failed', detail: `${item.summary}: ${message}` })
        }
      }
      // drop completed items, keep failures/conflicts for review
      const remaining = this.local.outboxSnapshot().filter((o) => o.status !== 'DONE')
      this.local.setOutbox(remaining)
      this.local.setLastSync(new Date().toISOString())
      await this.refreshMirror()
    } finally {
      this.syncing = false
    }
    return { pushed, failed, conflicts }
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
          throw new Error(res.error)
        }
        return 'ok'
      }
      case 'transferBarangay': {
        const res = await remote.transferBarangay(p as never)
        if (!res.ok) throw new Error(res.error)
        return 'ok'
      }
      case 'setPersonStatus': {
        const res = await remote.setPersonStatus(p.id as never, p.status as never, p.reason as never)
        if (!res.ok) throw new Error(res.error)
        return 'ok'
      }
      case 'openDuplicateCase': {
        const res = await remote.openDuplicateCase(p.a as never, p.b as never, p.source as never, p.notes as never)
        if (!res.ok) throw new Error(res.error)
        return 'ok'
      }
      case 'resolveDuplicateCase': {
        const res = await remote.resolveDuplicateCase(p.caseId as never, p.resolution as never, p.notes as never)
        if (!res.ok) throw new Error(res.error)
        return 'ok'
      }
      case 'mergePersons': {
        const res = await remote.mergePersons(p.keepId as never, p.mergeId as never, p.options as never)
        if (!res.ok) throw new Error(res.error)
        return 'ok'
      }
      case 'upsertUser': {
        const res = await remote.upsertUser(p.input as never)
        if (!res.ok) throw new Error(res.error)
        return 'ok'
      }
      case 'upsertBarangay': {
        const res = await remote.upsertBarangay(p.input as never)
        if (!res.ok) throw new Error(res.error)
        return 'ok'
      }
      case 'saveSettings': {
        const res = await remote.saveSettings(p.patch as never)
        if (!res.ok) throw new Error(res.error)
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
