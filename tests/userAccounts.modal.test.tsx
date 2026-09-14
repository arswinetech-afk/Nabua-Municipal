/**
 * REGRESSION — the User Accounts dialog (Add account / Edit account).
 *
 * Reported from the field: “every keystroke is accepting/refreshing every letter
 * by letter”. The cause was in the shared Modal: its effect depended on the
 * `onClose` closure, so every keystroke re-ran the effect and called
 * `dialog.focus()`, pulling the caret out of the input the user was typing into.
 * On a phone the keyboard closes and reopens each time, which reads as the whole
 * screen refreshing.
 *
 * These tests type letter by letter — the way a person does — and fail if the
 * dialog steals focus, blurs the field, or remounts its inputs.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from '../src/App'
import { AppProvider } from '../src/state/AppProvider'
import { ToastProvider } from '../src/components/ui'

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

async function openUserAccounts() {
  const user = userEvent.setup()
  renderApp('/login')
  await user.type(await screen.findByLabelText(/official email address/i), 'admin@nabua.gov.ph')
  await user.type(screen.getByLabelText(/^password/i), 'Admin@NMBR2026')
  await user.click(screen.getByRole('button', { name: /^sign in$/i }))
  await screen.findByRole('heading', { name: /municipal dashboard/i }, { timeout: 15_000 })
  await user.click(screen.getByRole('link', { name: /^users$/i }))
  await screen.findByRole('heading', { name: /user accounts/i }, { timeout: 15_000 })
  return user
}

/**
 * Counts focus losses on the field while it is being typed into. A caret pulled
 * out of the input fires `blur`, which is exactly what the user saw.
 */
function watchFocusLoss(field: HTMLElement) {
  const counter = { blurs: 0, focusOuts: 0 }
  field.addEventListener('blur', () => { counter.blurs += 1 })
  field.addEventListener('focusout', () => { counter.focusOuts += 1 })
  return counter
}

describe('REGRESSION — User Accounts dialog keeps the caret while typing', () => {
  it('Add account: every letter types into Full name and the keyboard never closes', async () => {
    const user = await openUserAccounts()
    await user.click(screen.getByRole('button', { name: /add account/i }))

    const modal = await screen.findByRole('dialog')
    const name = screen.getByLabelText(/full name/i)
    expect(modal.contains(name)).toBe(true)

    // The dialog opens with the first field ready for typing.
    await waitFor(() => expect(name).toHaveFocus())

    const node = name as HTMLInputElement
    const focusLoss = watchFocusLoss(node)

    await user.type(name, 'Engr. Ramon Villaflor')

    expect(node).toHaveValue('Engr. Ramon Villaflor')
    expect(node).toHaveFocus()            // caret still in the field
    expect(focusLoss.blurs).toBe(0)       // the field was never yanked away
    expect(document.activeElement).toBe(node)
    // The very same DOM node is still mounted: the dialog did not rebuild itself.
    expect(screen.getByLabelText(/full name/i)).toBe(node)

    // The other fields behave the same way.
    const email = screen.getByLabelText(/official email/i) as HTMLInputElement
    const emailFocusLoss = watchFocusLoss(email)
    await user.click(email)
    await user.type(email, 'ramon.villaflor@nabua.gov.ph')
    expect(email).toHaveValue('ramon.villaflor@nabua.gov.ph')
    expect(email).toHaveFocus()
    expect(emailFocusLoss.blurs).toBe(0)
    expect(name).toHaveValue('Engr. Ramon Villaflor') // earlier field is intact

    const scope = screen.getByLabelText(/barangay scope/i) as HTMLInputElement
    const scopeFocusLoss = watchFocusLoss(scope)
    await user.click(scope)
    await user.type(scope, 'San Isidro')
    expect(scope).toHaveValue('San Isidro')
    expect(scopeFocusLoss.blurs).toBe(0)
  })

  it('Edit account: correcting a name letter by letter stays in the field', async () => {
    const user = await openUserAccounts()

    // Open the first staff account in the table.
    const editButtons = await screen.findAllByRole('button', { name: /^edit$/i })
    await user.click(editButtons[0])

    const dialog = await screen.findByRole('dialog')
    const name = await waitFor(() => {
      const field = screen.getByLabelText(/full name/i) as HTMLInputElement
      expect(field.value.length).toBeGreaterThan(0) // pre-filled from the record
      return field
    })

    const focusLoss = watchFocusLoss(name)
    await user.click(name)
    await user.type(name, ' Jr.')

    expect(name.value.endsWith(' Jr.')).toBe(true)
    expect(name).toHaveFocus()
    expect(focusLoss.blurs).toBe(0)
    expect(dialog.contains(name)).toBe(true)
  })

  it('a re-render of the parent page does not steal focus from an open dialog', async () => {
    const user = await openUserAccounts()
    await user.click(screen.getByRole('button', { name: /add account/i }))
    const modal = await screen.findByRole('dialog')

    const name = screen.getByLabelText(/full name/i) as HTMLInputElement
    await waitFor(() => expect(name).toHaveFocus())
    await user.type(name, 'Marites')
    expect(name).toHaveFocus()

    // Force the page behind the dialog to re-render, without any pointer action
    // that would legitimately move focus itself.
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(name).toHaveValue('Marites'))
    await waitFor(() => expect(modal.contains(name)).toBe(true))
    expect(name).toHaveFocus()
  })

  it('typing does not re-run the dialog effects (no scroll-lock churn)', async () => {
    const user = await openUserAccounts()
    await user.click(screen.getByRole('button', { name: /add account/i }))
    const name = (await screen.findByRole('dialog')) && (screen.getByLabelText(/full name/i) as HTMLInputElement)
    await waitFor(() => expect(name).toHaveFocus())

    // The dialog sets the page scroll lock when it opens. While it stays open and
    // the user types, no further effect work may happen.
    const setSpy = vi.spyOn(document.body.style, 'overflow', 'set')
    await user.type(name, 'Ramon')
    expect(setSpy).not.toHaveBeenCalled()
    setSpy.mockRestore()

    expect(document.body.style.overflow).toBe('hidden') // still locked, as it should be
  })
})
