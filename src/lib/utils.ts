import { clsx, type ClassValue } from 'clsx'

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}

const TZ = 'Asia/Manila'

export function formatDate(value?: string | Date | null, opts?: Intl.DateTimeFormatOptions): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value.length <= 10 ? `${value}T00:00:00+08:00` : value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-PH', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', ...opts })
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-PH', {
    timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export function formatTime(value?: string | Date | null): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
}

export function relativeTime(value?: string | Date | null): string {
  if (!value) return 'never'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return 'never'
  const diff = Date.now() - d.getTime()
  const mins = Math.round(diff / 60000)
  if (Math.abs(mins) < 1) return 'just now'
  if (Math.abs(mins) < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (Math.abs(hours) < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (Math.abs(months) < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

export function isToday(value?: string | null): boolean {
  if (!value) return false
  const d = new Date(value)
  const now = new Date()
  return (
    d.toLocaleDateString('en-PH', { timeZone: TZ }) === now.toLocaleDateString('en-PH', { timeZone: TZ })
  )
}

export function uid(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return prefix ? `${prefix}${rnd}` : rnd
}

export async function sha256Hex(input: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    // extremely defensive fallback (non-cryptographic) — demo store only
    let h = 0
    for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0
    return `fallback${h}`
  }
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function percent(n: number): string {
  return `${Math.round(n)}%`
}

export function pluralize(n: number, singular: string, plural?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural ?? singular + 's'}`
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  const wrapped = (...args: Parameters<T>) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  wrapped.cancel = () => t && clearTimeout(t)
  return wrapped
}

/** Bounded in-memory index for the offline duplicate pool (memory hygiene). */
export function clampIndex<T>(rows: T[], max: number): T[] {
  return rows.length <= max ? rows : rows.slice(0, max)
}

export const PERSON_STATUS_TONE: Record<string, string> = {
  ACTIVE: 'success',
  INACTIVE: 'neutral',
  TRANSFERRED: 'info',
  DECEASED: 'muted',
  FOR_REVIEW: 'warning',
  ARCHIVED: 'muted',
}

export const MATCH_TONE: Record<string, string> = {
  VERY_LIKELY: 'danger',
  POSSIBLE: 'warning',
  POTENTIAL: 'info',
  DISTINCT: 'neutral',
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

// ---------------------------------------------------------------------
// Excel exports go through the same workbook library the import page
// uses to read them (already a dependency, loaded on demand).
//
// Why not CSV: CSV files prefixed with a UTF-8 byte-order mark kept get
// misdecoded by spreadsheet apps — the BOM surfaced as "ï»¿" in cell A1
// (field report 2026-09-16, Google Sheets on Android), and apps that
// ignore the BOM mangle every ñ in the registry. A real .xlsx declares
// its encoding inside the XML, needs no BOM, opens natively in Excel,
// Google Sheets and LibreOffice, and round-trips through our importer.
// ---------------------------------------------------------------------

export function downloadBlob(content: BlobPart, filename: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export type XlsxCell = string | number | null | undefined

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Build a one-sheet .xlsx workbook in memory (ZIP container, UTF-8 XML). */
export async function buildXlsxBytes(sheetName: string, headers: string[], rows: XlsxCell[][]): Promise<Uint8Array> {
  const { default: XLSX } = await import('xlsx')
  const clean = (v: XlsxCell) => (v === null || v === undefined ? '' : v)
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => r.map(clean))])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Export')
  const raw = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array
  return raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw)
}

export async function downloadXlsx(headers: string[], rows: XlsxCell[][], filename: string, sheetName = 'Export') {
  const bytes = await buildXlsxBytes(sheetName, headers, rows)
  downloadBlob(bytes.buffer as ArrayBuffer, filename, XLSX_MIME)
}
