import { useEffect, useMemo, useState } from 'react'
import { cn, downloadPdf, downloadXlsx, printPdf } from '../lib/utils'
import { useAppOptional } from '../state/AppProvider'
import { Button, EmptyState, IconColumns, IconDownload, IconFilter, IconPrint, IconSearch, Pagination, TableSkeleton, useToast } from './ui'

export type Column<T> = {
  key: string
  header: string
  /** value used for sorting + CSV export */
  value: (row: T) => string | number | null | undefined
  /** custom cell renderer */
  render?: (row: T) => React.ReactNode
  align?: 'left' | 'right' | 'center'
  sortable?: boolean
  /** hide on narrow screens (mobile shows the primary columns only) */
  hideOnMobile?: boolean
  defaultHidden?: boolean
  className?: string
}

type DataTableProps<T> = {
  rows: T[]
  columns: Array<Column<T>>
  rowKey: (row: T) => string
  loading?: boolean
  emptyTitle?: string
  emptyMessage?: string
  emptyAction?: React.ReactNode
  onRowClick?: (row: T) => void
  /** total number of records across all pages (enables pagination) */
  total?: number
  limit?: number
  offset?: number
  onPage?: (offset: number) => void
  /** search box */
  search?: string
  onSearch?: (value: string) => void
  searchPlaceholder?: string
  /** filter controls rendered next to the search box */
  filters?: React.ReactNode
  exportName?: string
  /** letterhead title for the PDF extract (defaults to a tidied exportName) */
  exportTitle?: string
  /** per-row action buttons (screen only — never part of exports) */
  renderActions?: (row: T) => React.ReactNode
  /** fetches EVERY filtered record for exports (exports must not be page-limited) */
  fetchExportRows?: () => Promise<T[]>
  mobilePrimary?: string[]
  dense?: boolean
  stickyHeader?: boolean
}

export function DataTable<T>({
  rows, columns, rowKey, loading, emptyTitle = 'No records found', emptyMessage, emptyAction,
  onRowClick, total, limit = 25, offset = 0, onPage, search, onSearch, searchPlaceholder,
  filters, exportName, exportTitle, renderActions, fetchExportRows, mobilePrimary, dense, stickyHeader = true,
}: DataTableProps<T>) {
  const user = useAppOptional()?.user ?? null
  const toast = useToast()
  const [exportMenu, setExportMenu] = useState(false)
  const [exportBusy, setExportBusy] = useState<null | 'xlsx' | 'pdf'>(null)
  // field directive 2026-09-22: PDF/print first ASK which columns to hide
  const [exportDialog, setExportDialog] = useState<null | 'pdf' | 'print'>(null)
  const [includeCols, setIncludeCols] = useState<string[]>([])
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [hidden, setHidden] = useState<string[]>(
    columns.filter((c) => c.defaultHidden).map((c) => c.key),
  )
  const [showColumns, setShowColumns] = useState(false)
  const [showFilters, setShowFilters] = useState(false)

  /**
   * Pages build their `columns` array on every render, so the array identity is
   * never stable: depending on it directly made this effect run (and write state)
   * on every keystroke anywhere on the page. The signature below only changes
   * when the set of columns really changes, and updating `hidden` returns the
   * previous array when nothing was dropped, which lets React skip the render.
   */
  const columnSignature = columns.map((c) => c.key).join('\u0000')

  useEffect(() => {
    const known = new Set(columnSignature ? columnSignature.split('\u0000') : [])
    setHidden((prev) => {
      const next = prev.filter((k) => known.has(k))
      return next.length === prev.length ? prev : next
    })
  }, [columnSignature])

  const visible = columns.filter((c) => !hidden.includes(c.key))
  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return rows
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = col.value(a)
      const bv = col.value(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv), 'en', { numeric: true }) * dir
    })
  }, [rows, columns, sortKey, sortDir])

  const primaryKeys = mobilePrimary ?? columns.slice(0, 2).map((c) => c.key)

  /**
   * Exports always give feedback: the 2026-09-16 field report ("Export is no
   * longer clickable") was a silent rejection — generation hides behind a
   * dynamic module fetch, so on a slow link the tap appeared dead and any
   * throw vanished. Busy state + error toast make both visible, and the
   * modules are pre-warmed at idle (AppProvider) so the first tap is fast.
   */
  const openExportDialog = (kind: 'pdf' | 'print') => {
    setExportMenu(false)
    setIncludeCols(columns.filter((c) => !hidden.includes(c.key)).map((c) => c.key))
    setExportDialog(kind)
  }

  const doExport = async (kind: 'xlsx' | 'pdf' | 'print') => {
    setExportMenu(false)
    setExportDialog(null)
    setExportBusy(kind === 'print' ? 'pdf' : kind)
    try {
      // exports cover EVERY filtered record, not just the visible page
      const all = fetchExportRows ? await fetchExportRows() : sorted
      const capped = all.slice(0, 10_000)
      const cols = kind === 'xlsx'
        ? columns.filter((c) => !hidden.includes(c.key))
        : columns.filter((c) => includeCols.includes(c.key))
      if (cols.length === 0) {
        toast.push({ tone: 'warning', title: 'Nothing to export', message: 'Tick at least one column.' })
        return
      }
      const headers = cols.map((c) => c.header)
      const grid = capped.map((row) => cols.map((c) => c.value(row) ?? ''))
      const base = `${exportName ?? 'nmbr-export'}-${new Date().toISOString().slice(0, 10)}`
      if (kind === 'xlsx') {
        await downloadXlsx(headers, grid, `${base}.xlsx`, exportName ?? 'Export')
      } else {
        const pretty = (exportTitle ?? (exportName ?? 'registry-extract').replace(/[-_]+/g, ' '))
          .replace(/^\w/, (ch) => ch.toUpperCase())
        const hiddenNames = columns.filter((c) => !cols.includes(c)).map((c) => c.header)
        const ex = {
          title: pretty,
          subtitle: 'Municipality of Nabua, Province of Camarines Sur',
          headers,
          rows: grid,
          filename: `${base}.pdf`,
          meta: [
            `Generated: ${new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}`,
            `Generated by: ${user?.name ?? 'System'} (${user?.role ?? 'system'})`,
            `Records in this extract: ${grid.length}${all.length > capped.length ? ` (first 10,000 of ${all.length})` : ''}`,
            ...(hiddenNames.length ? [`Columns hidden: ${hiddenNames.join(', ')}`] : []),
          ],
          landscape: true,
        }
        if (kind === 'print') await printPdf(ex)
        else await downloadPdf(ex)
        if (kind === 'print') {
          toast.push({
            tone: 'success', title: 'Sent to the print service',
            message: 'Choose the office printer in the dialog that just opened (it is preselected where the browser knows it).',
          })
        }
      }
    } catch (err) {
      toast.push({
        tone: 'error', title: 'Export failed',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setExportBusy(null)
    }
  }

  return (
    <div className="card overflow-hidden print-full">
      {(onSearch || filters || exportName || columns.length > 3) && (
        <div className="no-print flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
          {onSearch && (
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <IconSearch className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-slate-400" />
              <input
                className="input pl-8"
                value={search ?? ''}
                onChange={(e) => onSearch(e.target.value)}
                placeholder={searchPlaceholder ?? 'Search…'}
                aria-label="Search records"
              />
            </div>
          )}
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            {filters && (
              <>
                <Button variant="secondary" size="sm" className="sm:hidden" onClick={() => setShowFilters((v) => !v)}>
                  <IconFilter /> Filters
                </Button>
                <div className={cn('flex flex-wrap items-center gap-2', !showFilters && 'hidden sm:flex')}>{filters}</div>
              </>
            )}
            <div className="relative">
              <Button variant="secondary" size="sm" onClick={() => setShowColumns((v) => !v)} aria-expanded={showColumns}>
                <IconColumns /> Columns
              </Button>
              {showColumns && (
                <div className="animate-fade absolute right-0 z-20 mt-1 w-56 rounded-md border border-line bg-white p-2 shadow-lg">
                  {columns.map((c) => (
                    <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={!hidden.includes(c.key)}
                        onChange={(e) =>
                          setHidden((prev) => (e.target.checked ? prev.filter((k) => k !== c.key) : [...prev, c.key]))
                        }
                      />
                      {c.header}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {exportName && (
              <>
                <Button variant="secondary" size="sm" onClick={() => openExportDialog('print')}>
                  <IconPrint /> Print
                </Button>
              <div className="relative">
                <Button variant="secondary" size="sm" loading={exportBusy !== null}
                  onClick={() => setExportMenu((v) => !v)} aria-haspopup="menu" aria-expanded={exportMenu}>
                  <IconDownload /> Export
                </Button>
                {exportMenu && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setExportMenu(false)} />
                    <div role="menu" className="card absolute right-0 z-30 mt-1 w-60 bg-white p-1 shadow-lg">
                      <button role="menuitem" disabled={exportBusy !== null}
                        className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-ink hover:bg-slate-100 disabled:opacity-50"
                        onClick={() => void doExport('xlsx')}>
                        Excel workbook (.xlsx)
                      </button>
                      <button role="menuitem" disabled={exportBusy !== null}
                        className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-ink hover:bg-slate-100 disabled:opacity-50"
                        onClick={() => openExportDialog('pdf')}>
                        PDF document (.pdf)…
                      </button>
                    </div>
                  </>
                )}
              </div>
              </>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={6} cols={Math.min(visible.length, 6)} />
      ) : sorted.length === 0 ? (
        <EmptyState title={emptyTitle} message={emptyMessage} action={emptyAction} />
      ) : (
        <>
          {/* desktop / tablet table */}
          <div className="table-wrap hidden sm:block">
            <table className={cn('table', dense && 'table-compact')}>
              <thead className={cn(stickyHeader && 'sticky top-0')}>
                <tr>
                  {visible.map((c) => (
                    <th
                      key={c.key}
                      className={cn(c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.className)}
                      aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      {c.sortable === false ? (
                        c.header
                      ) : (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 font-semibold uppercase hover:text-ink"
                          onClick={() => {
                            if (sortKey === c.key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
                            else {
                              setSortKey(c.key)
                              setSortDir('asc')
                            }
                          }}
                        >
                          {c.header}
                          {sortKey === c.key && <span aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                        </button>
                      )}
                    </th>
                  ))}
                  {renderActions && <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr
                    key={rowKey(row)}
                    className={cn(onRowClick && 'cursor-pointer')}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {visible.map((c) => (
                      <td key={c.key} className={cn(c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}>
                        {c.render ? c.render(row) : String(c.value(row) ?? '—')}
                      </td>
                    ))}
                    {renderActions && <td className="px-3 py-2 text-right">{renderActions(row)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* mobile card list */}
          <ul className="divide-y divide-line sm:hidden">
            {sorted.map((row) => {
              const primary = visible.filter((c) => primaryKeys.includes(c.key))
              const secondary = visible.filter((c) => !primaryKeys.includes(c.key))
              return (
                <li
                  key={rowKey(row)}
                  className={cn('px-3 py-3', onRowClick && 'active:bg-slate-50')}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  <div className="flex flex-col gap-1.5">
                    {primary.map((c) => (
                      <div key={c.key}>{c.render ? c.render(row) : String(c.value(row) ?? '—')}</div>
                    ))}
                  </div>
                  {secondary.length > 0 && (
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                      {secondary.map((c) => (
                        <div key={c.key} className="min-w-0">
                          <dt className="text-ink-soft">{c.header}</dt>
                          <dd className="truncate font-medium text-ink">
                            {c.render ? c.render(row) : String(c.value(row) ?? '—')}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {onPage && total != null && (
        <div className="border-t border-line">
          <Pagination total={total} limit={limit} offset={offset} onChange={onPage} />
        </div>
      )}
    {exportDialog && (
      <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center" role="dialog" aria-modal="true">
        <div className="card w-full max-w-md bg-white p-4 shadow-xl">
          <h2 className="text-base font-bold text-ink">Prepare the document</h2>
          <p className="mt-1 text-xs text-ink-soft">
            Optional — untick any column you want hidden on the printed / downloaded document
            (for example Tags or Contact). The screen layout is not affected.
          </p>
          <div className="mt-3 max-h-64 overflow-auto rounded-md border border-line p-2">
            {columns.map((c) => (
              <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={includeCols.includes(c.key)}
                  onChange={(e) => setIncludeCols((prev) => (e.target.checked ? [...prev, c.key] : prev.filter((k) => k !== c.key)))}
                />
                {c.header}
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setExportDialog(null)}>Cancel</Button>
            <Button variant="secondary" size="sm" loading={exportBusy !== null} onClick={() => void doExport('pdf')}>
              <IconDownload /> Download PDF
            </Button>
            <Button variant="primary" size="sm" loading={exportBusy !== null} onClick={() => void doExport('print')}>
              <IconPrint /> Print now
            </Button>
          </div>
        </div>
      </div>
    )}
    </div>
  )
}
