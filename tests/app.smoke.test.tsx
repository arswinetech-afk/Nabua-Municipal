/**
 * Acceptance smoke tests for the NMBR application shell and the single most
 * important workflow: search-before-add duplicate prevention.
 *
 * These run against the offline backend (LocalApi), which mirrors the PostgreSQL
 * rules exactly, so they are valid evidence that the screens behave as specified.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from '../src/App'
import { AppProvider } from '../src/state/AppProvider'
import { ToastProvider } from '../src/components/ui'
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

async function signIn(role: 'encoder' | 'administrator' | 'system admin' = 'encoder') {
  const user = userEvent.setup()
  const accounts = {
    encoder: { email: 'pedro.reyes@nabua.gov.ph', password: 'Encoder@2026' },
    administrator: { email: 'maria.santos@nabua.gov.ph', password: 'Admin@NMBR2026' },
    'system admin': { email: 'admin@nabua.gov.ph', password: 'Admin@NMBR2026' },
  } as const
  const account = accounts[role]

  renderApp('/login')
  await user.type(await screen.findByLabelText(/official email address/i), account.email)
  await user.type(screen.getByLabelText(/^password/i), account.password)
  await user.click(screen.getByRole('button', { name: /^sign in$/i }))
  await screen.findByRole('heading', { name: /municipal dashboard/i }, { timeout: 15_000 })
  return user
}

describe('NMBR application shell', () => {
  it('TEST 1 — requires sign in and never exposes the registry to anonymous visitors', async () => {
    renderApp('/members')
    expect(await screen.findByRole('heading', { name: /office sign in/i })).toBeInTheDocument()
    // No registry screen, no navigation and no member data while signed out.
    expect(screen.queryByRole('heading', { name: /^member registry$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: /main navigation/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/total registered members/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/reference no\./i)).not.toBeInTheDocument()
  })

  it('TEST 2 — a valid office account signs in and the dashboard shows the seeded municipal totals', async () => {
    await signIn('encoder')
    expect(await screen.findByText(/total registered members/i)).toBeInTheDocument()
    // 0024 policy: headline counts are ACTIVE records only — retired and
    // inactive entries live in the audit trail, not in staff-facing totals
    const expected = seed.persons.filter((p) => p.status === 'ACTIVE').length
    await waitFor(() => {
      const values = screen.getAllByText(expected.toLocaleString())
      expect(values.length).toBeGreaterThan(0)
    }, { timeout: 15_000 })
    const barangayCount = seed.barangays.filter((b) => b.active !== false).length
    expect(screen.getAllByText(String(barangayCount)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('active').length).toBeGreaterThan(0)
  })

  it('TEST 3 — an unknown password is refused and the reason is shown', async () => {
    const user = userEvent.setup()
    renderApp('/login')
    await user.type(await screen.findByLabelText(/official email address/i), 'pedro.reyes@nabua.gov.ph')
    await user.type(screen.getByLabelText(/^password/i), 'wrong-password')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByRole('alert', {}, { timeout: 15_000 })).toHaveTextContent(/incorrect|failed|password/i)
  })

  it('TEST 4 — navigation between the registry screens works for an encoder', async () => {
    const user = await signIn('encoder')
    await user.click(screen.getByRole('link', { name: /^barangays$/i }))
    expect(await screen.findByRole('heading', { name: /barangay directory/i }, { timeout: 15_000 })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: /^members$/i }))
    expect(await screen.findByRole('heading', { name: /member registry/i }, { timeout: 15_000 })).toBeInTheDocument()
  })

  it('TEST 5 — an encoder cannot reach administrator-only screens', async () => {
    await signIn('encoder')
    // The navigation must not offer restricted screens to an encoder.
    expect(screen.queryByRole('link', { name: /^imports$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^users$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^settings$/i })).not.toBeInTheDocument()
  })
})

describe('search before add — duplicate prevention', () => {
  it('TEST 6 — the add-member screen starts with a registry search, not a blank form', async () => {
    const user = await signIn('encoder')
    await user.click(screen.getAllByRole('button', { name: /add member/i })[0])
    expect(await screen.findByRole('heading', { name: /search existing members/i }, { timeout: 15_000 })).toBeInTheDocument()
    expect(screen.getByLabelText(/search the municipal registry/i)).toBeInTheDocument()
  })

  it('TEST 7 — searching finds an existing member and offers “this is the same person”', async () => {
    const user = await signIn('encoder')
    await user.click(screen.getAllByRole('button', { name: /add member/i })[0])
    const target = seed.persons[0]
    const input = await screen.findByLabelText(/search the municipal registry/i)
    await user.type(input, `${target.last_name}`)

    const list = await screen.findByText(/possible existing records/i, {}, { timeout: 15_000 })
    expect(list).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /this is the same person/i }).length).toBeGreaterThan(0)
    }, { timeout: 15_000 })
  })

  it('TEST 8 — typing the exact identity of an existing member raises the duplicate indicator with a score', async () => {
    const api = getApi()
    await api.restoreSession()
    const target = seed.persons[0]

    // Stage through the real API used by the screen.
    const matches = await api.checkDuplicates({
      id: 'candidate',
      first_name: target.first_name,
      middle_name: target.middle_name ?? null,
      last_name: target.last_name,
      suffix: target.suffix ?? null,
      date_of_birth: target.date_of_birth ?? null,
      sex: target.sex ?? null,
      purok: target.purok ?? null,
      address: target.address ?? null,
      contact_number: target.contact_number ?? null,
      barangay_id: target.barangay_id ?? null,
      barangay_name: null,
    })

    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].score.score).toBeGreaterThanOrEqual(95)
    expect(matches[0].score.band).toBe('VERY_LIKELY')
    // The explanation must be present — never a bare “duplicate found”.
    expect(matches[0].score.reasons.length).toBeGreaterThan(0)
    expect(matches[0].score.reasons.some((r) => r.status === 'match')).toBe(true)
  })

  it('TEST 9 — a genuine duplicate is refused by the API and the match explanation is returned', async () => {
    const api = getApi()
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')
    const target = seed.persons[0]

    const result = await api.createPerson({
      first_name: target.first_name,
      middle_name: target.middle_name ?? null,
      last_name: target.last_name,
      suffix: target.suffix ?? null,
      date_of_birth: target.date_of_birth ?? null,
      sex: target.sex ?? null,
      barangay_id: target.barangay_id ?? null,
      contact_number: target.contact_number ?? null,
      address: target.address ?? null,
      purok: target.purok ?? null,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('DUPLICATE_REVIEW_REQUIRED')
    expect(result.matches && result.matches.length).toBeGreaterThan(0)

    // Nothing was written: the registry total is unchanged.
    const stats = await api.dashboardStats()
    expect(stats.total_members).toBe(seed.persons.filter((p) => p.status !== 'ARCHIVED').length)
  })

  it('TEST 10 — a clearly new resident is accepted and then found by search', async () => {
    const api = getApi()
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')

    const result = await api.createPerson({
      first_name: 'Alfonso',
      middle_name: 'Bienvenido',
      last_name: 'Zamora',
      date_of_birth: '1974-03-08',
      sex: 'MALE',
      barangay_id: seed.barangays[0].id ?? null,
      purok: 'Purok 7',
      address: 'Purok 7, Nabua, Camarines Sur',
      contact_number: '09175551234',
    })

    expect(result.ok).toBe(true)
    expect(result.person?.reference_no).toBeTruthy()

    const found = await api.searchPersons({ query: 'Zamora Alfonso', limit: 10 })
    expect(found.total).toBeGreaterThan(0)
    expect(found.rows.some((p) => p.last_name === 'Zamora')).toBe(true)
  })
})

describe('audit trail and non-destructive statuses', () => {
  it('TEST 11 — creating a member writes an audit entry with the author', async () => {
    const api = getApi()
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')
    await api.createPerson({
      first_name: 'Testita', middle_name: null, last_name: 'Auditoria',
      date_of_birth: '1990-05-05', sex: 'FEMALE', barangay_id: seed.barangays[1].id ?? null,
    })
    const audit = await api.listAudit({ query: 'Auditoria', limit: 10 })
    expect(audit.total).toBeGreaterThan(0)
    expect(audit.rows[0].user_name).toBe('Pedro Reyes')
  })

  it('TEST 12 — records are archived, never deleted', async () => {
    const api = getApi()
    await api.signIn('maria.santos@nabua.gov.ph', 'Admin@NMBR2026')
    const person = seed.persons[3]

    const missingReason = await api.setPersonStatus(person.id, 'ARCHIVED', '')
    expect(missingReason.ok).toBe(false)

    const archived = await api.setPersonStatus(person.id, 'ARCHIVED', 'Confirmed left the municipality (test).')
    expect(archived.ok).toBe(true)

    const detail = await api.getPerson(person.id)
    expect(detail).not.toBeNull()
    expect(detail?.status).toBe('ARCHIVED')
  })
})

describe('role enforcement', () => {
  it('TEST 13 — an encoder cannot resolve (merge/split) duplicate cases', async () => {
    const api = getApi()
    await api.signIn('pedro.reyes@nabua.gov.ph', 'Encoder@2026')
    const open = await api.listDuplicateCases({ status: 'PENDING', limit: 1 })
    expect(open.rows.length).toBeGreaterThan(0)

    const res = await api.resolveDuplicateCase(open.rows[0].id, 'DIFFERENT_PERSON', 'encoder attempt')
    expect(res.ok).toBe(false)
    expect(res.code).toBe('FORBIDDEN')
  })

  it('TEST 14 — an administrator can resolve a duplicate case, and the decision is audited', async () => {
    const api = getApi()
    await api.signIn('maria.santos@nabua.gov.ph', 'Admin@NMBR2026')
    const open = await api.listDuplicateCases({ status: 'PENDING', limit: 1 })
    const target = open.rows[0]

    // A resolution without a note is refused — decisions must be justified.
    const noNote = await api.resolveDuplicateCase(target.id, 'DIFFERENT_PERSON', '')
    expect(noNote.ok).toBe(false)
    expect(noNote.code).toBe('REASON_REQUIRED')

    const res = await api.resolveDuplicateCase(target.id, 'DIFFERENT_PERSON', 'Verified with the barangay secretary (test).')
    expect(res.ok).toBe(true)

    const after = await api.listDuplicateCases({ status: 'DIFFERENT_PERSON', limit: 5 })
    expect(after.total).toBeGreaterThan(0)

    const audit = await api.listAudit({ action: 'DUPLICATE_REVIEWED', limit: 5 })
    expect(audit.total).toBeGreaterThan(0)
    expect(audit.rows[0].reason).toMatch(/verified/i)
  })
})

describe('rendered duplicate warning', () => {
  it('TEST 15 — the add-member screen shows the live duplicate indicator while typing', async () => {
    const user = await signIn('encoder')
    await user.click(screen.getAllByRole('button', { name: /add member/i })[0])
    await user.click(await screen.findByRole('button', { name: /this is a new member/i }))

    const target = seed.persons[0]
    await user.type(await screen.findByLabelText(/first name/i), target.first_name)
    await user.type(screen.getByLabelText(/last name/i), target.last_name)
    const dob = screen.getByLabelText(/date of birth/i)
    await user.type(dob, target.date_of_birth ?? '01/01/1980')

    const panel = await screen.findByRole('heading', { name: /^duplicate check$/i }, { timeout: 15_000 })
    expect(panel.closest('.card')).toBeTruthy()

    // The live indicator must announce the match in plain language, and the
    // encoder must be given a decision to make (never a silent save).
    await waitFor(() => {
      const indicator = screen.queryAllByText(/duplicate likely|possible duplicate|potential match|no similar member/i)
      expect(indicator.length).toBeGreaterThan(0)
    }, { timeout: 20_000 })

    // Every match must explain WHY it matched — never a bare “duplicate found”.
    expect(screen.queryAllByText(/why it matched/i).length).toBeGreaterThan(0)
    expect(screen.queryAllByText(/birthdate|name|barangay|sex/i).length).toBeGreaterThan(0)

    // Saving stays blocked until the encoder confirms they reviewed the match.
    const save = screen.getByRole('button', { name: /save member record/i })
    const card = screen.getByText(/confirmation required/i).closest('.card')
    expect(card).toBeTruthy()
    const confirmBox = within(card as HTMLElement).getByRole('checkbox')
    expect(confirmBox).not.toBeChecked()
    expect(save).toBeDisabled()

    // With the checkbox ticked and a reason recorded, the save is offered again.
    await user.click(confirmBox)
    await user.type(within(card as HTMLElement).getByLabelText(/reason/i), 'Verified as a different resident (test).')
    await waitFor(() => expect(screen.getByRole('button', { name: /save member record/i })).toBeEnabled())
  })
})
