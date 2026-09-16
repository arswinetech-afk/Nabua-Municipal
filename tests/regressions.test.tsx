/**
 * Regression tests for two faults reported from the field:
 *
 *  1. Typing into a modal field (Add barangay) lost the caret after every
 *     keystroke, because the Modal stole focus back on each render.
 *  2. Changes queued while the central database was not yet deployed were
 *     reported as hard FAILURES and retried endlessly, instead of being held as
 *     “waiting for the server setup”.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from '../src/App'
import { AppProvider } from '../src/state/AppProvider'
import { ToastProvider } from '../src/components/ui'
import { Modal, Field, Button } from '../src/components/ui'
import { ApiClient, isProvisioningFailure, WAITING_FOR_SETUP_MESSAGE, WAITING_FOR_SIGNIN_MESSAGE } from '../src/lib/apiClient'
import type { RemoteApi } from '../src/lib/remoteApi'
import { isSchemaMissingError } from '../src/lib/remoteApi'
import { getApi } from '../src/lib/apiClient'
import seed from '../src/data/seed.json'

function renderApp(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <ToastProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
}

async function signInAsAdministrator() {
  const user = userEvent.setup()
  renderApp('/login')
  await user.type(await screen.findByLabelText(/official email address/i), 'maria.santos@nabua.gov.ph')
  await user.type(screen.getByLabelText(/^password/i), 'Admin@NMBR2026')
  await user.click(screen.getByRole('button', { name: /^sign in$/i }))
  await screen.findByRole('heading', { name: /municipal dashboard/i }, { timeout: 15_000 })
  return user
}

describe('REGRESSION 1 — typing in a modal keeps the caret', () => {
  it('accepts every letter of a multi-character entry without losing focus', async () => {
    const user = await signInAsAdministrator()
    await user.click(screen.getByRole('link', { name: /^barangays$/i }))
    await screen.findByRole('heading', { name: /barangay directory/i }, { timeout: 15_000 })

    await user.click(screen.getByRole('button', { name: /add barangay/i }))
    const name = await screen.findByLabelText(/barangay name/i)
    await waitFor(() => expect(name).toHaveFocus())

    // Type character by character, the way a person does.
    await user.type(name, 'La Purisima')
    expect(name).toHaveValue('La Purisima')
    expect(name).toHaveFocus()

    // …and the second field behaves the same way.
    const district = screen.getByLabelText(/district/i)
    await user.click(district)
    await user.type(district, 'Poblacion Cluster')
    expect(district).toHaveValue('Poblacion Cluster')
    expect(district).toHaveFocus()
    expect(name).toHaveValue('La Purisima') // earlier input is not wiped out
  })

  it('the Modal only moves focus once, when it opens', async () => {
    const user = userEvent.setup()
    function Harness() {
      return (
        <Modal open onClose={() => undefined} title="Test dialog">
          <Field label="First field">
            <input className="input" />
          </Field>
          <Field label="Second field">
            <input className="input" />
          </Field>
          <Button>Unrelated</Button>
        </Modal>
      )
    }
    render(<Harness />)
    const first = screen.getByLabelText(/first field/i)
    await waitFor(() => expect(first).toHaveFocus())

    // Re-rendering the dialog (new inline callbacks) must not steal focus.
    await user.type(first, 'abcdef')
    expect(first).toHaveValue('abcdef')
    expect(first).toHaveFocus()

    const second = screen.getByLabelText(/second field/i)
    await user.click(second)
    await user.type(second, 'xyz')
    expect(second).toHaveValue('xyz')
    expect(second).toHaveFocus()
  })
})

describe('REGRESSION 2 — a server without the NMBR schema is not a failure', () => {
  it('recognises the PostgREST “schema cache” errors that mean “not deployed yet”', () => {
    // Verbatim shapes returned by PostgREST when the migrations have not been run.
    expect(isSchemaMissingError({
      code: 'PGRST202',
      message: 'Could not find the function public.fn_create_person(p, p_confirmed_distinct, p_reason) in the schema cache',
      details: 'Searched for the function public.fn_create_person with parameters p, p_confirmed_distinct, p_reason.',
    })).toBe(true)

    expect(isSchemaMissingError({
      code: 'PGRST205',
      message: "Could not find the table 'public.barangays' in the schema cache",
      details: null,
    })).toBe(true)

    expect(isSchemaMissingError({ code: '42883', message: 'function fn_dashboard_stats() does not exist' })).toBe(true)
    expect(isSchemaMissingError({ code: '42P01', message: 'relation "public.persons" does not exist' })).toBe(true)

    // Ordinary database answers must NOT be mistaken for a missing schema.
    expect(isSchemaMissingError({ code: 'P0005', message: 'NMBR_DUPLICATE: a master record already matches this person' })).toBe(false)
    expect(isSchemaMissingError({ code: 'P0002', message: 'NMBR_FORBIDDEN: role ENCODER may not perform this action' })).toBe(false)
    expect(isSchemaMissingError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isSchemaMissingError(null)).toBe(false)
  })

  it('classifies a provisioning failure so the queue is held, not failed', () => {
    const notProvisioned = Object.assign(new Error('Could not find the function public.fn_create_person in the schema cache'), {
      code: 'PGRST202',
    })
    expect(isProvisioningFailure(notProvisioned)).toBe(true)

    // A genuine network drop is a different situation: it stays retryable.
    const offline = Object.assign(new Error('Failed to fetch'), { code: undefined })
    expect(isProvisioningFailure(offline)).toBe(false)

    // A duplicate refusal is a decision for a human, not a provisioning problem.
    expect(isProvisioningFailure(Object.assign(new Error('NMBR_DUPLICATE'), { code: 'P0005' }))).toBe(false)
  })

  it('tells the user queued work is safe while the database is missing', () => {
    expect(WAITING_FOR_SETUP_MESSAGE).toMatch(/safe on this device/i)
    expect(WAITING_FOR_SETUP_MESSAGE).toMatch(/created|set up/i)
  })

  it('exposes the deployment state so the screens can explain it', () => {
    const api = getApi()
    // The test build has no Supabase project configured, so the app must say
    // exactly that instead of claiming the database is missing or ready.
    expect(api.serverStatus).toBe('unconfigured')
  })

  it('keeps working locally while the database is unavailable, and queues the change', async () => {
    const api = getApi()
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')
    const before = (await api.dashboardStats()).total_members

    const created = await api.createPerson({
      first_name: 'Norberto', middle_name: null, last_name: 'Quezada',
      date_of_birth: '1988-11-02', sex: 'MALE', barangay_id: seed.barangays[2].id ?? null,
    })
    expect(created.ok).toBe(true)

    // The record exists for the encoder straight away…
    const after = (await api.dashboardStats()).total_members
    expect(after).toBe(before + 1)

    // …and the change is queued for the server rather than being lost.
    const queued = api.pendingChanges().filter((p) => p.operation === 'createPerson')
    expect(queued.length).toBeGreaterThan(0)
    expect(queued[0].status).not.toBe('DONE')

    // Nothing should have been marked as a hard failure by the missing database.
    const failed = api.pendingChanges().filter((p) => p.status === 'FAILED' && /not been set up|schema cache/i.test(p.error ?? ''))
    expect(failed.length).toBe(0)
  })
})

/**
 * The reported field scenario, reproduced exactly: an encoder queues a member
 * while Supabase is reachable but has never had the NMBR schema deployed.
 * Before the fix this produced "FAILED … Could not find the function
 * public.fn_create_person … in the schema cache" and retried every minute.
 */
describe('REGRESSION 2b — queued work against a Supabase project with no schema', () => {
  const pgrst202 = () => Object.assign(
    new Error('Could not find the function public.fn_create_person(p, p_confirmed_distinct, p_reason) in the schema cache'),
    { code: 'PGRST202', details: 'Searched for the function public.fn_create_person.', hint: null, status: 404 },
  )

  function makeRemote(probe: 'ready' | 'missing'): {
    remote: RemoteApi
    calls: { createPerson: number; probeSchema: number }
  } {
    const calls = { createPerson: 0, probeSchema: 0 }
    const remote = {
      mode: 'supabase' as const,
      offlineCapable: false,
      async probeSchema() {
        calls.probeSchema++
        return probe
      },
      async signIn() {
        return { ok: false as const, error: 'No NMBR profile is linked to this account.', code: 'NO_PROFILE' }
      },
      async setSession() { /* nothing to cache */ },
      async createPerson() {
        calls.createPerson++
        throw pgrst202()
      },
      async listBarangays() { return seed.barangays.map((b, i) => ({ id: `b${i}`, name: b.name, active: true, municipality: 'Nabua', province: 'Camarines Sur', created_at: '' })) },
      async personIndex() { return [] },
      async listDuplicateCases() { return { total: 0, rows: [] } },
    } as unknown as RemoteApi
    return { remote, calls }
  }

  it('holds the queue as “waiting for setup” instead of reporting failures', async () => {
    const { remote, calls } = makeRemote('missing')
    const api = new ApiClient({ remote })
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')

    // Nothing checked yet — the app asks the server on sign-in and on sync.
    expect(api.serverStatus).toBe('unknown')
    expect(await api.checkServer()).toBe('missing')
    expect(api.serverStatus).toBe('missing')

    // Writes must not be aimed at a database that cannot accept them.
    expect(api.usingServer).toBe(false)

    const created = await api.createPerson({
      first_name: 'Arnel', middle_name: 'Reyes', last_name: 'Tech', date_of_birth: '1991-04-17',
      sex: 'MALE', barangay_id: seed.barangays[0].id ?? null,
    })
    expect(created.ok).toBe(true)

    const result = await api.syncNow()
    expect(result).toEqual({ pushed: 0, failed: 0, conflicts: 0 })

    const queued = api.pendingChanges().filter((p) => p.operation === 'createPerson')
    expect(queued).toHaveLength(1)
    expect(queued[0].status).toBe('PENDING')       // not FAILED
    expect(queued[0].attempts).toBe(0)             // no retry burn-down
    expect(queued[0].error).toBe(WAITING_FOR_SETUP_MESSAGE)
    // The server was consulted once to establish the state, not once per retry.
    expect(calls.probeSchema).toBeGreaterThanOrEqual(1)

    // The member is still usable locally while the database is missing.
    const found = await api.searchPersons({ query: 'Arnel Tech', limit: 5 })
    expect(found.total).toBe(1)
  })

  it('uploads the held queue automatically once the schema is deployed', async () => {
    const calls = { pushed: 0 }
    // The administrator runs the setup SQL while the encoder waits.
    let schema: 'missing' | 'ready' = 'missing'
    const remote = {
      mode: 'supabase' as const,
      offlineCapable: false,
      async probeSchema() { return schema },
      async signIn() {
        // Until the schema exists there is no NMBR profile to link, so sign-in
        // falls back to the on-device registry exactly as it did in the field.
        return { ok: false as const, error: 'No NMBR profile is linked to this account.', code: 'NO_PROFILE' }
      },
      setSession() { /* nothing to cache */ },
      async createPerson() {
        calls.pushed++
        return {
          ok: true as const,
          person: {
            id: 'srv-1', reference_no: 'NMBR-999001', first_name: 'Marites', middle_name: null,
            last_name: 'Bautista', suffix: null, date_of_birth: '1979-02-02', sex: 'FEMALE',
            civil_status: null, contact_number: null, address: null, purok: null, barangay_id: null,
            status: 'ACTIVE' as const, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          },
        }
      },
      async listBarangays() { return [] },
      async personIndex() { return [] },
      async listDuplicateCases() { return { total: 0, rows: [] } },
    } as unknown as RemoteApi

    const api = new ApiClient({ remote })
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')
    await api.createPerson({
      first_name: 'Marites', middle_name: null, last_name: 'Bautista',
      date_of_birth: '1979-02-02', sex: 'FEMALE', barangay_id: seed.barangays[0].id ?? null,
    })
    const held = api.pendingChanges().filter((p) => p.status !== 'DONE')
    expect(held).toHaveLength(1)
    expect(held[0].status).toBe('PENDING')

    // The database is deployed; the queue uploads on the next sync by itself.
    schema = 'ready'
    await api.recheckServer()
    const result = await api.syncNow()
    expect(result.pushed).toBe(1)
    expect(result.failed).toBe(0)
    expect(calls.pushed).toBe(1)
    expect(api.pendingChanges().filter((p) => p.status !== 'DONE')).toHaveLength(0)
  })
})

/**
 * REGRESSION 3 — field report 2026-09-15 (go-live blocking).
 *
 * Reproduced from the phone screenshots: the municipal server was reachable
 * and set up, but the device had no session the server recognised (the sign-in
 * had fallen back to the on-device registry). Every queued change was replayed
 * against the database every minute and refused with "Your session is not
 * recognised. Please sign in again." — 6, 24, 31, 46 attempts — although no
 * number of retries can ever produce a session.
 *
 * Required behaviour: the refusal is recognised as a *state* (no active
 * session), the queue is parked on the device without burning attempts, the
 * automatic timer stops replaying it, and a sign-in to the municipal server
 * flushes everything by itself.
 */
describe('REGRESSION 3 — a refused session parks the queue instead of burning retries', () => {
  const unauthenticated = () => Object.assign(
    new Error('Your session is not recognised. Please sign in again.'),
    { code: 'P0002' },
  )

  function makeRemote() {
    const calls = { createPerson: 0, signIn: 0 }
    /** Flipped when the person finally signs in to the municipal server. */
    const state = { serverSession: false }
    const remote = {
      mode: 'supabase' as const,
      offlineCapable: false,
      async probeSchema() { return 'ready' as const },
      async signIn(email: string) {
        calls.signIn++
        if (!state.serverSession) {
          // The sign-in falls back to the on-device registry, exactly as in
          // the field: Supabase had no auth user linked to a profile yet.
          return { ok: false as const, error: 'No NMBR profile is linked to this account.', code: 'NO_PROFILE' }
        }
        return {
          ok: true as const,
          data: {
            id: 'u-real', name: 'Real Encoder', email, role: 'ENCODER' as const,
            active: true, barangay_scope: null, last_login: null,
          },
        }
      },
      setSession() { /* nothing to cache */ },
      async createPerson() {
        calls.createPerson++
        if (!state.serverSession) throw unauthenticated()
        return {
          ok: true as const,
          person: {
            id: 'srv-real-1', reference_no: 'NMBR-900001', first_name: 'Liza', middle_name: null,
            last_name: 'Mercado', suffix: null, date_of_birth: '1988-08-08', sex: 'FEMALE',
            civil_status: null, contact_number: null, address: null, purok: null, barangay_id: null,
            status: 'ACTIVE' as const, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          },
        }
      },
      async listBarangays() { return [] },
      async personIndex() { return [] },
      async listDuplicateCases() { return { total: 0, rows: [] } },
    } as unknown as RemoteApi
    return { remote, calls, state }
  }

  it('parks refused work as “waiting for sign-in” with zero attempts burned', async () => {
    const { remote, calls } = makeRemote()
    const api = new ApiClient({ remote })
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')
    expect(api.usingServer).toBe(false) // fell back to the on-device registry

    await api.createPerson({
      first_name: 'Liza', middle_name: null, last_name: 'Quebral',
      date_of_birth: '1988-08-08', sex: 'FEMALE', barangay_id: seed.barangays[0].id ?? null,
    })

    const result = await api.syncNow()
    expect(result).toEqual({ pushed: 0, failed: 0, conflicts: 0 })

    const queued = api.pendingChanges().filter((p) => p.operation === 'createPerson')
    expect(queued).toHaveLength(1)
    expect(queued[0].status).toBe('PENDING')            // not FAILED
    expect(queued[0].attempts).toBe(0)                  // no retry burn-down
    expect(queued[0].error).toBe(WAITING_FOR_SIGNIN_MESSAGE)
    expect(api.needsSignIn).toBe(true)
    expect(calls.createPerson).toBe(1)                  // one replay, one refusal

    // The every-minute timer must not hammer a server that can only answer
    // "sign in again": while parked, sync is a no-op.
    await api.syncNow()
    await api.syncNow()
    expect(calls.createPerson).toBe(1)
    expect(api.pendingChanges().filter((p) => p.operation === 'createPerson')[0].attempts).toBe(0)

    // The member stays usable on the device while the queue waits.
    const found = await api.searchPersons({ query: 'Liza Quebral', limit: 5 })
    expect(found.total).toBe(1)
  })

  it('flushes the parked queue automatically once the person signs in', async () => {
    const { remote, calls, state } = makeRemote()
    const api = new ApiClient({ remote })
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')
    await api.createPerson({
      first_name: 'Liza', middle_name: null, last_name: 'Quebral',
      date_of_birth: '1988-08-08', sex: 'FEMALE', barangay_id: seed.barangays[0].id ?? null,
    })
    await api.syncNow()
    expect(api.needsSignIn).toBe(true)

    // The administrator links the account (or the encoder signs in with the
    // office credentials): the server session returns and the queue uploads
    // without anyone pressing a retry button.
    state.serverSession = true
    const signedIn = await api.signIn('real.encoder@nabua.gov.ph', 'Office@2026')
    expect(signedIn.ok).toBe(true)

    await waitFor(() => {
      expect(calls.createPerson).toBe(2) // one refusal while parked, one accepted replay
      expect(api.pendingChanges().filter((p) => p.status !== 'DONE')).toHaveLength(0)
    }, { timeout: 10_000 })
    expect(api.needsSignIn).toBe(false)
  })
})

/**
 * REGRESSION 4 — field report 2026-09-15, second Sync Centre screenshot.
 *
 * Two queued items were retried 27 and 67 times against refusals no retry
 * can cure: a role the session does not hold (P0003), and a member encoded
 * against the on-device demonstration registry whose barangay id ("b008")
 * is not a uuid the server can know (22P02). Such refusals are decisions
 * for a human — park them as CONFLICT once, never replay them again.
 */
describe('REGRESSION 4 — permanent rejections become decisions, not retry loops', () => {
  function makeRemote() {
    const calls = { createPerson: 0, upsertUser: 0 }
    const remote = {
      mode: 'supabase' as const,
      offlineCapable: false,
      async probeSchema() { return 'ready' as const },
      async signIn() {
        return { ok: false as const, error: 'No NMBR profile is linked to this account.', code: 'NO_PROFILE' }
      },
      setSession() { /* nothing to cache */ },
      async createPerson() {
        calls.createPerson++
        throw Object.assign(new Error('invalid input syntax for type uuid: "b008"'), { code: '22P02' })
      },
      async upsertUser() {
        calls.upsertUser++
        // The stale copy collides with the profile that now exists on the
        // server: unique violation, another refusal no retry can cure.
        return {
          ok: false as const, code: '23505',
          error: 'duplicate key value violates unique constraint "users_email_key"',
        }
      },
      async listBarangays() { return [] },
      async personIndex() { return [] },
      async listDuplicateCases() { return { total: 0, rows: [] } },
    } as unknown as RemoteApi
    return { remote, calls }
  }

  it('parks un-replayable entries as “needs your decision” and never replays them again', async () => {
    const { remote, calls } = makeRemote()
    const api = new ApiClient({ remote })
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')

    // A member encoded against the on-device (demonstration) registry…
    await api.createPerson({
      first_name: 'AR', middle_name: null, last_name: 'Tech',
      date_of_birth: '1990-01-01', sex: 'MALE', barangay_id: 'b008',
    })
    // …and a stale user save queued twelve hours ago.
    api.local.queueOutbox({
      operation: 'upsertUser',
      payload: { input: { name: 'Stale Save', email: 'stale@nabua.gov.ph', role: 'ADMINISTRATOR' } },
      summary: 'Save user stale@nabua.gov.ph',
    })

    const result = await api.syncNow()
    expect(result).toEqual({ pushed: 0, failed: 0, conflicts: 2 })

    const items = api.pendingChanges()
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.status === 'CONFLICT')).toBe(true)
    expect(items.every((i) => (i.error ?? '').includes('Retrying cannot fix this'))).toBe(true)
    expect(items.every((i) => i.attempts === 0)).toBe(true)

    // The every-minute timer must leave decisions alone.
    await api.syncNow()
    await api.syncNow()
    expect(calls.createPerson).toBe(1)
    expect(calls.upsertUser).toBe(1)
  })
})

/**
 * REGRESSION 5 — field report 2026-09-15, 13:43 screenshot.
 *
 * Discarding a queued change wrote an audit event carrying the outbox id
 * ("ob…") as entity_id, a uuid column — so the audit event was itself
 * refused, became a new queued conflict, and discarding THAT wrote another
 * one (the accumulating SYNC_ITEM_DISCARDED prefixes). A refused audit event
 * must stay local; only link/provisioning failures may queue it.
 */
describe('REGRESSION 5 — discarding never breeds new queue entries', () => {
  function makeRemote(logEvent: () => Promise<void>) {
    return {
      mode: 'supabase' as const,
      offlineCapable: false,
      async probeSchema() { return 'ready' as const },
      async signIn() {
        return {
          ok: true as const,
          data: {
            id: 'u-pj', name: 'Paula Joy Quiñones', email: 'paulajoy@nabua.gov.ph',
            role: 'SYSTEM_ADMIN' as const, active: true, barangay_scope: null, last_login: null,
          },
        }
      },
      setSession() { /* nothing to cache */ },
      logEvent,
      async listBarangays() { return [] },
      async personIndex() { return [] },
      async listDuplicateCases() { return { total: 0, rows: [] } },
    } as unknown as RemoteApi
  }

  it('a permanently refused audit event stays local instead of queueing', async () => {
    const remote = makeRemote(async () => {
      throw Object.assign(new Error('invalid input syntax for type uuid: "ob123"'), { code: '22P02' })
    })
    const api = new ApiClient({ remote })
    await api.signIn('paulajoy@nabua.gov.ph', 'Office@2026')
    await api.logEvent('SYNC_ITEM_DISCARDED', 'OUTBOX', null, 'Save user stale',
      { outbox_id: 'ob123', operation: 'upsertUser' }, 'cleaning the queue')
    expect(api.pendingChanges()).toHaveLength(0)
  })

  it('a network-refused audit event still queues (it succeeds once the link returns)', async () => {
    const remote = makeRemote(async () => { throw new TypeError('Failed to fetch') })
    const api = new ApiClient({ remote })
    await api.signIn('paulajoy@nabua.gov.ph', 'Office@2026')
    await api.logEvent('SYNC_ITEM_DISCARDED', 'OUTBOX', null, 'Save user stale', null, 'cleaning the queue')
    expect(api.pendingChanges().filter((p) => p.operation === 'logEvent')).toHaveLength(1)
  })
})

/**
 * REGRESSION 6 — field report 2026-09-15: "opened it on my PC with no
 * internet, it doesn't work".
 *
 * A production device carries no demonstration accounts, and its offline
 * sign-in verifier is written only by that device's own first ONLINE sign-in
 * (with the password). Before this fix a never-introduced device answered
 * "No office account matches that email address" offline — indistinguishable
 * from a wrong password. The remedy must be stated: one online sign-in per
 * device, then offline sign-in works with the same credentials.
 */
describe('REGRESSION 6 — offline sign-in on a device the server has met', () => {
  function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value })
  }

  function makeRemote() {
    return {
      mode: 'supabase' as const,
      offlineCapable: false,
      async probeSchema() { return 'ready' as const },
      async signIn(email: string) {
        return {
          ok: true as const,
          data: {
            id: 'u-pj', name: 'Paula Joy Quiñones', email,
            role: 'SYSTEM_ADMIN' as const, active: true, barangay_scope: null, last_login: null,
          },
        }
      },
      async signOut() { /* nothing to do */ },
      setSession() { /* nothing to cache */ },
      async listBarangays() { return [] },
      async personIndex() { return [] },
      async listDuplicateCases() { return { total: 0, rows: [] } },
    } as unknown as RemoteApi
  }

  it('a never-introduced device explains the one-time online sign-in instead of blaming the password', async () => {
    setOnline(false)
    const api = new ApiClient({ remote: makeRemote() })
    const res = await api.signIn('paulajoy@nabua.gov.ph', 'Office@2026')
    expect(res.ok).toBe(false)
    expect((res as { code?: string }).code).toBe('NO_OFFLINE_CREDENTIAL')
    expect(res.error).toMatch(/sign in once/i)
    setOnline(true)
  })

  it('after the first online sign-in the same credentials work with no connection', async () => {
    setOnline(true)
    const api = new ApiClient({ remote: makeRemote() })
    const online = await api.signIn('paulajoy@nabua.gov.ph', 'Office@2026')
    expect(online.ok).toBe(true)
    await api.signOut()

    // The link dies mid-shift…
    setOnline(false)
    const offline = await api.signIn('paulajoy@nabua.gov.ph', 'Office@2026')
    expect(offline.ok).toBe(true)
    expect(offline.ok && offline.data.email).toBe('paulajoy@nabua.gov.ph')

    // …and a wrong password still fails offline.
    await api.signOut()
    const wrong = await api.signIn('paulajoy@nabua.gov.ph', 'Wrong@123')
    expect(wrong.ok).toBe(false)
    setOnline(true)
  })
})

/**
 * REGRESSION 7 — field request 2026-09-16: the "New today" cards open the
 * member list restricted to records encoded since local midnight, online
 * (fn_search_persons p_created_since, migration 0010) AND offline (local
 * mirror). The list the card opens must match the number on the card.
 */
describe('REGRESSION 7 — the since-midnight list matches the card count', () => {
  it('the local mirror honours created_since', async () => {
    const api = new ApiClient({})
    const admin = await api.local.signIn('admin@nabua.gov.ph', 'Admin@NMBR2026')
    expect(admin.ok).toBe(true)
    const created = await api.local.createPerson({
      first_name: 'Since', middle_name: '', last_name: 'Midnight',
      sex: 'FEMALE', date_of_birth: '1990-01-01', barangay_id: null,
      purok: '', address: '', contact_number: '',
    } as never)
    expect(created.ok).toBe(true)

    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const tomorrow = new Date(today.getTime() + 86_400_000)
    const isoTomorrow = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    const withToday = await api.local.searchPersons({ created_since: iso, limit: 100 })
    expect(withToday.rows.some((r) => r.last_name === 'Midnight')).toBe(true)
    const withTomorrow = await api.local.searchPersons({ created_since: isoTomorrow, limit: 100 })
    expect(withTomorrow.rows.some((r) => r.last_name === 'Midnight')).toBe(false)
    expect(withTomorrow.total).toBe(0)
  })
})

/**
 * REGRESSION 8 — field report 2026-09-16, 08:16 screenshot: every exported
 * "Excel" file opened with "ï»¿" glued to cell A1. Those exports were CSV
 * text prefixed with a UTF-8 byte-order mark; spreadsheet apps that decode
 * Windows-1252 show the BOM as characters (and mangle every ñ besides).
 * Exports are now genuine .xlsx workbooks built with the same library the
 * import page reads them with — no BOM anywhere, encoding declared in XML.
 */
describe('REGRESSION 8 — exports are real workbooks, round-trip UTF-8 verbatim', () => {
  it('builds a .xlsx (ZIP magic, no BOM) that re-imports with ñ intact', async () => {
    const { buildXlsxBytes } = await import('../src/lib/utils')
    const { default: XLSX } = await import('xlsx')
    const bytes = await buildXlsxBytes('Members', ['Member', 'Barangay', 'Count'], [
      ['Quiñones, Paula', 'SAN JUAN', 2],
      ['Sarah Mae Neñez', 'ANGUSTIA', ''],
    ])
    // A ZIP container, never a BOM-prefixed text file.
    expect(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04).toBe(true)
    expect(String.fromCharCode(...bytes.slice(0, 8))).not.toContain('\uFEFF')

    // …and the import path reads back exactly what the office encoded.
    const wb = XLSX.read(bytes, { type: 'array' })
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
    expect(json).toHaveLength(2)
    expect(json[0]).toMatchObject({ Member: 'Quiñones, Paula', Barangay: 'SAN JUAN', Count: 2 })
    expect(json[1]).toMatchObject({ Member: 'Sarah Mae Neñez', Barangay: 'ANGUSTIA' })
  })
})

/**
 * REGRESSION 9 — field request 2026-09-16: extracts must also download as a
 * clean, professional government PDF — letterhead, navy table head, page
 * furniture stamped after pagination so nothing overlaps the table.
 */
describe('REGRESSION 9 — PDF extracts carry the letterhead and paginate cleanly', () => {
  it('builds a %PDF with letterhead, running head and page numbers', async () => {
    const { buildPdfBytes } = await import('../src/lib/utils')
    const rows = Array.from({ length: 90 }, (_, i) => [
      `NMBR-${String(i + 1).padStart(6, '0')}`, `Member ${i + 1}`, 'SAN JUAN',
    ])
    const bytes = await buildPdfBytes({
      title: 'Municipal Member Registry',
      subtitle: 'Municipality of Nabua, Province of Camarines Sur',
      headers: ['Reference No.', 'Name', 'Barangay'],
      rows,
      filename: 'x.pdf',
      meta: ['Generated: test run', 'Records in this extract: 90'],
      compress: false,
    })
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-')
    const text = Buffer.from(bytes).toString('latin1')
    expect(text).toContain('REPUBLIC OF THE PHILIPPINES')
    expect(text).toContain('PROVINCE OF CAMARINES SUR')
    expect(text).toContain('MUNICIPALITY OF NABUA')
    expect(text).toContain('MUNICIPAL MEMBER REGISTRY')
    expect(text).toContain('Records in this extract: 90')
    // multi-page extract: footers know the real total, running head on page 2
    expect(text).toMatch(/Page 1 of [2-9]/)
    expect(text).toContain('continued')
    expect(text).toContain('Official system-generated document')
  })
})

/**
 * REGRESSION 10 — field report 2026-09-16, 09:15: Excel export failed with
 * "Cannot read properties of undefined (reading 'utils')". The xlsx package
 * is dual-mode: Node loads its CJS build (default export present), browser
 * bundles load its ESM build (named exports only). The loader must accept
 * both shapes and refuse silently-broken ones.
 */
describe('REGRESSION 10 — the spreadsheet module loader accepts both module shapes', () => {
  it('resolves named-export (ESM) and default-export (CJS) shapes alike', async () => {
    const { pickXlsx } = await import('../src/lib/utils')
    const lib = { utils: { aoa_to_sheet: () => ({}) } }
    expect(pickXlsx(lib)).toBe(lib)                       // browser ESM shape
    expect(pickXlsx({ default: lib })).toBe(lib)          // node CJS shape
    expect(() => pickXlsx({})).toThrow(/spreadsheet module did not load/)
    expect(() => pickXlsx(undefined)).toThrow(/spreadsheet module did not load/)
  })
})
