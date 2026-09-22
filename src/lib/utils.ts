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

/**
 * The xlsx package is dual-mode: Node resolves its CommonJS build (which has
 * a default export) while browser bundles resolve its ESM build (named
 * exports only, NO default) — field report 2026-09-16 09:15, "Cannot read
 * properties of undefined (reading 'utils')". Accept either shape and fail
 * loudly if neither carries the library.
 */
export function pickXlsx(mod: unknown): typeof import('xlsx') {
  const m = mod as { default?: { utils?: unknown } | undefined; utils?: unknown }
  const lib = (m?.default?.utils ? m.default : m) as typeof import('xlsx') | undefined
  if (!lib?.utils) {
    throw new Error('The spreadsheet module did not load. Re-open the app (it refreshes in the background) and try again.')
  }
  return lib
}

/** Build a one-sheet .xlsx workbook in memory (ZIP container, UTF-8 XML). */
export async function buildXlsxBytes(sheetName: string, headers: string[], rows: XlsxCell[][]): Promise<Uint8Array> {
  const XLSX = pickXlsx(await import('xlsx'))
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

// ---------------------------------------------------------------------
// Official PDF extracts: A4, government letterhead, navy table head,
// zebra rows, page furniture that never overlaps the table (the table
// keeps an 18 mm bottom margin; footers live below it).
// ---------------------------------------------------------------------

export type PdfExtract = {
  title: string
  subtitle?: string
  headers: string[]
  rows: XlsxCell[][]
  filename: string
  /** Extra meta lines under the letterhead (generated by, filters…). */
  meta?: string[]
  /** Uncompressed streams (tests only; production extracts compress). */
  compress?: boolean
  /** Landscape A4 — the default for wide registry extracts (field directive
   *  2026-09-22: portrait cropped the personal information). */
  landscape?: boolean
}

const NAVY: [number, number, number] = [31, 56, 100]
const GRAY: [number, number, number] = [107, 114, 128]
const INK: [number, number, number] = [17, 24, 39]

export async function buildPdfDoc(ex: PdfExtract): Promise<import('jspdf').jsPDF> {
  const { jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  const doc = new jsPDF({
    unit: 'mm', format: 'a4', orientation: ex.landscape ? 'landscape' : 'portrait',
    compress: ex.compress ?? true,
  })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 14

  // ---- letterhead (first page) ----
  let y = 16
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
  doc.text('REPUBLIC OF THE PHILIPPINES', W / 2, y, { align: 'center' }); y += 5
  doc.setFontSize(9.5); doc.setFont('helvetica', 'normal')
  doc.text('PROVINCE OF CAMARINES SUR', W / 2, y, { align: 'center' }); y += 4.6
  doc.text('MUNICIPALITY OF NABUA', W / 2, y, { align: 'center' }); y += 3
  doc.setDrawColor(...NAVY); doc.setLineWidth(0.8)
  doc.line(M, y, W - M, y); y += 7
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...NAVY)
  doc.text(ex.title.toUpperCase(), W / 2, y, { align: 'center', maxWidth: W - 2 * M }); y += 6
  if (ex.subtitle) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GRAY)
    doc.text(ex.subtitle, W / 2, y, { align: 'center', maxWidth: W - 2 * M }); y += 5.5
  }
  doc.setFontSize(8); doc.setTextColor(...GRAY); doc.setFont('helvetica', 'normal')
  for (const line of ex.meta ?? []) {
    doc.text(line, M, y); y += 4.2
  }
  const startY = y + 2

  // ---- table ----
  autoTable(doc, {
    head: [ex.headers],
    body: ex.rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))),
    startY,
    margin: { left: M, right: M, top: 16, bottom: 18 },
    styles: {
      font: 'helvetica', fontSize: 9, textColor: INK, cellPadding: 1.8,
      lineWidth: 0.15, lineColor: [209, 213, 219], overflow: 'linebreak',
    },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9.2 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    didDrawPage: () => { /* footers are stamped after pagination is final */ },
  })

  // ---- running head (page 2+) and footers (all pages), stamped last so
  //      the page count is known and nothing can overlap the table ----
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    if (i > 1) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.4); doc.setTextColor(...NAVY)
      doc.text(ex.title.toUpperCase(), M, 10, { maxWidth: W - 2 * M })
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...GRAY)
      doc.text('continued', W - M, 10, { align: 'right' })
      doc.setDrawColor(...NAVY); doc.setLineWidth(0.4)
      doc.line(M, 12, W - M, 12)
    }
    doc.setDrawColor(209, 213, 219); doc.setLineWidth(0.2)
    doc.line(M, H - 12, W - M, H - 12)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.4); doc.setTextColor(...GRAY)
    doc.text('Official system-generated document — Municipal Barangay Registry, Municipality of Nabua, Camarines Sur',
      M, H - 8)
    doc.text(`Page ${i} of ${pages}`, W - M, H - 8, { align: 'right' })
  }

  return doc
}

export async function buildPdfBytes(ex: PdfExtract): Promise<Uint8Array> {
  const doc = await buildPdfDoc(ex)
  return new Uint8Array(doc.output('arraybuffer'))
}

export async function downloadPdf(ex: PdfExtract) {
  const bytes = await buildPdfBytes(ex)
  downloadBlob(bytes.buffer as ArrayBuffer, ex.filename, 'application/pdf')
}

/**
 * Field directive 2026-09-22: a Print button must send the document straight
 * to the office printer. The PDF is built with an auto-print flag and handed
 * to a hidden iframe, so the browser's print service opens with the document
 * ready — the office printer is preselected, no extra steps for staff.
 */
export async function printPdf(ex: PdfExtract) {
  const doc = await buildPdfDoc(ex)
  doc.autoPrint()
  const url = URL.createObjectURL(new Blob([doc.output('blob')], { type: 'application/pdf' }))
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '1px'
  frame.style.height = '1px'
  frame.style.border = '0'
  frame.setAttribute('aria-hidden', 'true')
  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
    } finally {
      window.setTimeout(() => { URL.revokeObjectURL(url); frame.remove() }, 120_000)
    }
  }
  frame.src = url
  document.body.appendChild(frame)
}
