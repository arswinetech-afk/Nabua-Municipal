/**
 * Pages build their `columns` array on every render, so its identity is never
 * stable. The table must tolerate that: re-creating the array must not disturb
 * what is displayed and must not resurrect a column the user hid.
 *
 * (The accompanying code change — not writing state when the column set is
 * unchanged — cannot be observed with a render counter here: React Testing
 * Library wraps events in `act()`, which batches the effect's update together
 * with the event that caused it. It is covered by the behavioural assertions
 * below and reviewed by hand.)
 */
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { DataTable, type Column } from '../src/components/DataTable'

type Row = { id: string; name: string; notes: string; purok: string; archive: string }

const rows: Row[] = [
  { id: '1', name: 'Maria Santos', notes: 'Filed 2019', purok: 'Purok 2', archive: 'A-1' },
  { id: '2', name: 'Jose Ramos', notes: 'Filed 2021', purok: 'Purok 5', archive: 'A-2' },
  { id: '3', name: 'Ana Villanueva', notes: 'Filed 2023', purok: 'Purok 1', archive: 'A-3' },
]

function Page({ extraColumns = true }: { extraColumns?: boolean }) {
  const [typing, setTyping] = useState('')
  // A brand new array on every render, exactly like every real page does.
  const columns: Array<Column<Row>> = [
    { key: 'name', header: 'Staff member', value: (r) => r.name, render: (r) => <span>{r.name}</span> },
    { key: 'notes', header: 'Notes', value: (r) => r.notes, render: (r) => <span>{r.notes}</span> },
    { key: 'purok', header: 'Purok', value: (r) => r.purok, render: (r) => <span>{r.purok}</span> },
    ...(extraColumns
      ? [{ key: 'archive', header: 'Archive note', value: (r: Row) => r.archive, defaultHidden: true, render: () => <span>—</span> }]
      : [{ key: 'extra', header: 'Other note', value: () => '', defaultHidden: true, render: () => <span>—</span> }]),
  ]
  return (
    <>
      <label>
        Full name
        <input value={typing} onChange={(e) => setTyping(e.target.value)} />
      </label>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} />
    </>
  )
}

describe('DataTable — a re-created columns array is harmless', () => {
  it('keeps the typed text, the rows and the hidden-column state under control', () => {
    const { rerender } = render(<Page />)

    // The page re-renders while a form field is being typed into.
    const field = screen.getByLabelText(/full name/i)
    fireEvent.change(field, { target: { value: 'Ra' } })
    fireEvent.change(field, { target: { value: 'Ramon' } })
    expect(field).toHaveValue('Ramon')

    // Rows are present (the table renders both a desktop table and phone cards).
    expect(screen.getAllByText('Maria Santos').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Jose Ramos').length).toBeGreaterThan(0)

    // A column marked default-hidden stays hidden across all that churn.
    expect(screen.queryByRole('columnheader', { name: /archive note/i })).toBeNull()

    // Revealing it still works, which proves the hidden-state effect kept working.
    fireEvent.click(screen.getByRole('button', { name: /columns/i }))
    fireEvent.click(screen.getByLabelText(/archive note/i))
    expect(screen.getByRole('columnheader', { name: /archive note/i })).toBeInTheDocument()

    // Replacing the column set entirely (new array, different keys) is safe, and
    // the typed value survives.
    rerender(<Page extraColumns={false} />)
    expect(screen.queryByRole('columnheader', { name: /archive note/i })).toBeNull()
    expect(screen.getByRole('columnheader', { name: /other note/i })).toBeInTheDocument()
    expect(field).toHaveValue('Ramon')
  })
})
