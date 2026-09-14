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

export function toCSV(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return ''
  const cols = columns ?? Object.keys(rows[0])
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\r\n')
}

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

export function downloadCSV(rows: Array<Record<string, unknown>>, filename: string, columns?: string[]) {
  downloadBlob('\uFEFF' + toCSV(rows, columns), filename)
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
