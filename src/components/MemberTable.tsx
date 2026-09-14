import { Link } from 'react-router-dom'
import type { Person } from '../lib/types'
import { formatDate, relativeTime } from '../lib/utils'
import { fullName, maskContact } from '../lib/normalize'
import { DataTable, type Column } from './DataTable'
import { Badge, StatusBadge } from './ui'

export function personColumns({
  maskContactNumbers = true,
  onOpen,
}: { maskContactNumbers?: boolean; onOpen?: (p: Person) => void } = {}): Array<Column<Person>> {
  return [
    {
      key: 'name', header: 'Member', value: (p) => fullName(p),
      render: (p) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">
            {fullName(p)}
            {p.suffix ? ` ${p.suffix}` : ''}
          </p>
          <p className="mono text-[11px] text-ink-soft">{p.reference_no}</p>
        </div>
      ),
    },
    {
      key: 'barangay', header: 'Barangay', value: (p) => p.barangay_name ?? '—',
      render: (p) => <span className="text-xs font-medium text-ink">{p.barangay_name ?? '—'}</span>,
    },
    {
      key: 'dob', header: 'Birthdate', value: (p) => p.date_of_birth ?? '',
      render: (p) => (p.date_of_birth
        ? <span className="text-xs">{formatDate(p.date_of_birth)}</span>
        : <Badge tone="warning">Missing</Badge>),
    },
    { key: 'sex', header: 'Sex', value: (p) => p.sex ?? '—', render: (p) => <span className="text-xs">{p.sex ? (p.sex === 'MALE' ? 'Male' : 'Female') : '—'}</span> },
    { key: 'purok', header: 'Purok / Sitio', value: (p) => p.purok ?? '—', defaultHidden: false },
    {
      key: 'contact', header: 'Contact', value: (p) => p.contact_number ?? '—',
      render: (p) => (
        <span className={p.contact_number && p.contact_number.replace(/\D/g, '').length < 7 ? 'text-amber-700' : ''}>
          {maskContactNumbers ? maskContact(p.contact_number) : (p.contact_number ?? '—')}
        </span>
      ),
    },
    {
      key: 'duplicates', header: 'Duplicates', value: (p) => p.open_duplicates ?? 0, align: 'center',
      render: (p) => ((p.open_duplicates ?? 0) > 0
        ? <Badge tone="danger">{p.open_duplicates} open</Badge>
        : <span className="text-[11px] text-ink-soft">none</span>),
    },
    { key: 'status', header: 'Status', value: (p) => p.status, render: (p) => <StatusBadge status={p.status} /> },
    {
      key: 'updated', header: 'Last update', value: (p) => p.updated_at, defaultHidden: true,
      render: (p) => <span className="text-[11px] text-ink-soft">{relativeTime(p.updated_at)}</span>,
    },
    {
      key: 'open', header: '', value: () => '', sortable: false,
      render: (p) => (
        <Link
          className="btn btn-secondary btn-sm"
          to={`/members/${p.id}`}
          onClick={(e) => {
            if (onOpen) {
              e.preventDefault()
              onOpen(p)
            }
          }}
        >
          Open
        </Link>
      ),
    },
  ]
}

export function MemberTable({
  rows, loading, total, limit, offset, onPage, onRowClick, emptyTitle, emptyMessage, emptyAction,
  search, onSearch, searchPlaceholder, filters, exportName, maskContactNumbers, mobilePrimary,
}: {
  rows: Person[]
  loading?: boolean
  total?: number
  limit?: number
  offset?: number
  onPage?: (offset: number) => void
  onRowClick?: (p: Person) => void
  emptyTitle?: string
  emptyMessage?: string
  emptyAction?: React.ReactNode
  search?: string
  onSearch?: (v: string) => void
  searchPlaceholder?: string
  filters?: React.ReactNode
  exportName?: string
  maskContactNumbers?: boolean
  mobilePrimary?: string[]
}) {
  return (
    <DataTable
      rows={rows}
      columns={personColumns({ maskContactNumbers, onOpen: onRowClick })}
      rowKey={(p) => p.id}
      loading={loading}
      total={total}
      limit={limit ?? 25}
      offset={offset ?? 0}
      onPage={onPage}
      onRowClick={onRowClick}
      emptyTitle={emptyTitle ?? 'No member records'}
      emptyMessage={emptyMessage ?? 'Adjust the filters, or add a new member record.'}
      emptyAction={emptyAction}
      search={search}
      onSearch={onSearch}
      searchPlaceholder={searchPlaceholder}
      filters={filters}
      exportName={exportName}
      mobilePrimary={mobilePrimary ?? ['name', 'barangay']}
    />
  )
}
