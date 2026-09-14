import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import { BAND_META, type MatchBand } from '../lib/duplicateEngine'

/* =====================================================================
   Icon set — inline SVG so the bundle stays small and works offline.
   ===================================================================== */
type IconProps = { className?: string }
const svg = (path: React.ReactNode) =>
  function Icon({ className }: IconProps) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" className={cn('h-4 w-4 shrink-0', className)} aria-hidden="true">
        {path}
      </svg>
    )
  }

export const IconDashboard = svg(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>)
export const IconMap = svg(<><path d="M9 3 3 5.5v16L9 19l6 2.5 6-2.5v-16L15 5.5 9 3Z" /><path d="M9 3v16M15 5.5v16" /></>)
export const IconUsers = svg(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>)
export const IconPerson = svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></>)
export const IconCopy = svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>)
export const IconShieldCheck = svg(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>)
export const IconUpload = svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5M12 3v12" /></>)
export const IconScroll = svg(<><path d="M4 4h13a3 3 0 0 1 3 3v10a3 3 0 0 0 3 3H7a3 3 0 0 1-3-3V4Z" /><path d="M8 8h8M8 12h6" /></>)
export const IconChart = svg(<><path d="M3 3v18h18" /><path d="M7 15v-4M12 17V7M17 17v-7" /></>)
export const IconCog = svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09c.2.6.75 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>)
export const IconSearch = svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>)
export const IconPlus = svg(<><path d="M12 5v14M5 12h14" /></>)
export const IconClose = svg(<><path d="M18 6 6 18M6 6l12 12" /></>)
export const IconMenu = svg(<><path d="M3 6h18M3 12h18M3 18h18" /></>)
export const IconAlert = svg(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>)
export const IconCheck = svg(<><path d="m20 6-11 11-5-5" /></>)
export const IconWifiOff = svg(<><path d="M2 2l20 20" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M5 12.9a10 10 0 0 1 3.5-2.1M2 8.8a15 15 0 0 1 4.2-2.5M22 8.8a15 15 0 0 0-8.7-3.3M12 20h.01M19 12.9c.5-.4 1-.8 1.5-1.3" /></>)
export const IconCloud = svg(<><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 9.5 4 4 0 0 0 6 17.5" /><path d="M12 12v9M8.5 15.5 12 12l3.5 3.5" /></>)
export const IconDownload = svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></>)
export const IconPrint = svg(<><path d="M6 9V2h12v7" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6 17h12v5H6z" /></>)
export const IconArrowRight = svg(<><path d="M5 12h14M13 6l6 6-6 6" /></>)
export const IconArrowLeft = svg(<><path d="M19 12H5M11 18l-6-6 6-6" /></>)
export const IconEye = svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>)
export const IconHistory = svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>)
export const IconFilter = svg(<><path d="M3 5h18l-7 8v6l-4 2v-8Z" /></>)
export const IconColumns = svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>)
export const IconRefresh = svg(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>)
export const IconLogout = svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>)
export const IconEdit = svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>)
export const IconMerge = svg(<><path d="M7 3v6a4 4 0 0 0 4 4h6" /><path d="m14 9 4 4-4 4" /><path d="M7 21v-6" /></>)
export const IconTrash = svg(<><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15" /></>)
export const IconUserCheck = svg(<><circle cx="9" cy="8" r="4" /><path d="M2 21v-1a6 6 0 0 1 6-6h3" /><path d="m16 16 2 2 4-4" /></>)
export const IconUserX = svg(<><circle cx="9" cy="8" r="4" /><path d="M2 21v-1a6 6 0 0 1 6-6h3" /><path d="m16 16 5 5M21 16l-5 5" /></>)
export const IconFlag = svg(<><path d="M4 22V4h9l-1 3h8l-2 5 2 5h-9l-1-3H4" /></>)
export const IconClock = svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>)
export const IconSave = svg(<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></>)
export const IconExternal = svg(<><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M21 3l-9 9" /></>)
export const IconSort = svg(<><path d="m3 8 4-4 4 4" /><path d="M7 4v16M21 16l-4 4-4-4" /><path d="M17 20V4" /></>)
export const IconBell = svg(<><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>)
export const IconSpinner = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={cn('h-4 w-4 animate-spin', className)} aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
  </svg>
)

/* =====================================================================
   Primitives
   ===================================================================== */
export function Button({
  variant = 'secondary', size, className, loading, children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'success'
  size?: 'sm' | 'lg'
  loading?: boolean
}) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cn('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', size === 'lg' && 'btn-lg', className)}
    >
      {loading && <IconSpinner />}
      {children}
    </button>
  )
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cn('card', className)}>{children}</div>
}

export function Badge({
  tone = 'neutral', className, children, icon,
}: { tone?: string; className?: string; children: React.ReactNode; icon?: React.ReactNode }) {
  return <span className={cn('badge', `badge-${tone}`, className)}>{icon}{children}</span>
}

export function StatusBadge({ status }: { status?: string | null }) {
  const map: Record<string, { tone: string; label: string }> = {
    ACTIVE: { tone: 'success', label: 'Active' },
    INACTIVE: { tone: 'neutral', label: 'Inactive' },
    TRANSFERRED: { tone: 'info', label: 'Transferred' },
    DECEASED: { tone: 'muted', label: 'Deceased' },
    FOR_REVIEW: { tone: 'warning', label: 'For review' },
    ARCHIVED: { tone: 'muted', label: 'Archived' },
    PENDING: { tone: 'warning', label: 'Pending review' },
    MERGED: { tone: 'info', label: 'Merged' },
    DIFFERENT_PERSON: { tone: 'success', label: 'Different people' },
    KEPT_BOTH: { tone: 'neutral', label: 'Both kept' },
    DEFERRED: { tone: 'info', label: 'Deferred' },
    DISMISSED: { tone: 'muted', label: 'Dismissed' },
  }
  const entry = map[status ?? ''] ?? { tone: 'neutral', label: status ?? '—' }
  return <Badge tone={entry.tone}>{entry.label}</Badge>
}

export function MatchBadge({ band, score, className }: { band?: MatchBand | string | null; score?: number; className?: string }) {
  const meta = BAND_META[(band ?? 'DISTINCT') as MatchBand] ?? BAND_META.DISTINCT
  return (
    <Badge tone={meta.tone} className={className}>
      {score != null ? `${Math.round(score)}% · ` : ''}
      {meta.label}
    </Badge>
  )
}

export function Field({
  label, hint, error, required, children, className,
}: { label?: string; hint?: string; error?: string; required?: boolean; children: React.ReactNode; className?: string }) {
  // Associate the caption with the control so screen readers (and tests) can find
  // every input by its label, even inside modals.
  const generatedId = React.useId()
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<{ id?: string }>, {
        id: (children.props as { id?: string }).id ?? generatedId,
      })
    : children
  return (
    <div className={className}>
      {label && (
        <label className="label" htmlFor={generatedId}>
          {label} {required && <span className="text-red-600">*</span>}
        </label>
      )}
      {control}
      {error ? <p className="field-error" role="alert">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export function Modal({
  open, onClose, title, description, children, footer, size = 'md', dismissable = true,
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  dismissable?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Callbacks are held in refs so the effect below depends only on `open`.
  // Depending on `onClose` meant the effect re-ran on every keystroke (each
  // render creates a new closure) and re-focused the dialog — which pulled the
  // caret out of whichever field the user was typing into.
  const closeRef = useRef(onClose)
  const dismissableRef = useRef(dismissable)
  closeRef.current = onClose
  dismissableRef.current = dismissable

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissableRef.current) closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Move focus into the dialog once, and only when it is not already inside:
    // this keeps keyboard users oriented without disturbing an input.
    const node = ref.current
    if (node && !node.contains(document.activeElement)) {
      const firstField = node.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )
      if (firstField) firstField.focus()
      else node.focus({ preventScroll: true })
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size]
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/45 p-0 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        ref={ref}
        tabIndex={-1}
        className={cn('animate-rise w-full rounded-t-xl bg-white shadow-xl sm:rounded-lg', width)}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-ink-soft">{description}</p>}
          </div>
          {dismissable && (
            <button onClick={onClose} className="btn btn-ghost btn-sm -mr-2" aria-label="Close">
              <IconClose />
            </button>
          )}
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-slate-50/70 px-4 py-3 sm:px-5">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary',
  requireReason, onConfirm, onClose, children,
}: {
  open: boolean
  title: string
  message: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'primary' | 'danger' | 'warning'
  requireReason?: boolean
  onConfirm: (reason: string) => void
  onClose: () => void
  children?: React.ReactNode
}) {
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (open) {
      setReason('')
      setTouched(false)
    }
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{cancelLabel}</Button>
          <Button
            variant={tone}
            onClick={() => {
              if (requireReason && !reason.trim()) {
                setTouched(true)
                return
              }
              onConfirm(reason.trim())
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink-soft">{message}</div>
      {children}
      {requireReason && (
        <Field label="Reason (stored in the audit trail)" required error={touched && !reason.trim() ? 'A reason is required.' : undefined}>
          <textarea
            className={cn('input', touched && !reason.trim() && 'input-error')}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Resident transfer confirmed with the barangay secretary"
          />
        </Field>
      )}
    </Modal>
  )
}

/* =====================================================================
   Toasts
   ===================================================================== */
export type Toast = { id: string; tone: 'success' | 'error' | 'info' | 'warning'; title: string; message?: string }
type ToastCtx = { push: (t: Omit<Toast, 'id'>) => void }
const ToastContext = createContext<ToastCtx>({ push: () => {} })

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((prev) => [...prev.slice(-3), { ...t, id }])
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.tone === 'error' ? 9000 : 5500)
  }, [])
  const value = useMemo(() => ({ push }), [push])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end sm:p-0">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'animate-rise pointer-events-auto w-full max-w-sm rounded-lg border bg-white px-4 py-3 shadow-lg',
              t.tone === 'success' && 'border-emerald-200',
              t.tone === 'error' && 'border-red-200',
              t.tone === 'warning' && 'border-amber-200',
              t.tone === 'info' && 'border-gov-200',
            )}
          >
            <div className="flex items-start gap-2">
              <span className={cn('mt-0.5',
                t.tone === 'success' && 'text-emerald-700',
                t.tone === 'error' && 'text-red-700',
                t.tone === 'warning' && 'text-amber-700',
                t.tone === 'info' && 'text-gov-700')}>
                {t.tone === 'success' ? <IconCheck /> : t.tone === 'error' ? <IconAlert /> : <IconCloud />}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{t.title}</p>
                {t.message && <p className="mt-0.5 text-xs break-words text-ink-soft">{t.message}</p>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

/* =====================================================================
   Feedback / structure helpers
   ===================================================================== */
export function EmptyState({
  icon, title, message, action,
}: { icon?: React.ReactNode; title: string; message?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        {icon ?? <IconSearch className="h-5 w-5" />}
      </div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {message && <p className="max-w-md text-xs text-ink-soft">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} />
}

export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
          {Array.from({ length: cols }).map((__, c) => <Skeleton key={c} className={c === 0 ? 'w-3/4' : 'w-1/2'} />)}
        </div>
      ))}
    </div>
  )
}

export function Pagination({
  total, limit, offset, onChange,
}: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const page = Math.floor(offset / limit) + 1
  const pages = Math.max(1, Math.ceil(total / limit))
  if (total <= limit) {
    return <p className="px-4 py-3 text-xs text-ink-soft">{total.toLocaleString()} record{total === 1 ? '' : 's'}</p>
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="text-xs text-ink-soft">
        Showing <span className="font-semibold text-ink">{offset + 1}</span>–
        <span className="font-semibold text-ink">{Math.min(offset + limit, total)}</span> of{' '}
        <span className="font-semibold text-ink">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
          <IconArrowLeft /> Prev
        </Button>
        <span className="px-2 text-xs font-semibold text-ink-soft">Page {page} / {pages}</span>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
          Next <IconArrowRight />
        </Button>
      </div>
    </div>
  )
}

export function KpiCard({
  label, value, sub, tone = 'neutral', icon, onClick,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'neutral' | 'danger' | 'warning' | 'success' | 'info'
  icon?: React.ReactNode
  onClick?: () => void
}) {
  const accent = {
    neutral: 'text-ink', danger: 'text-red-700', warning: 'text-amber-700',
    success: 'text-emerald-700', info: 'text-gov-800',
  }[tone]
  return (
    <Card
      className={cn('card-pad flex flex-col gap-1', onClick && 'cursor-pointer transition-shadow hover:shadow-md')}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-wide text-ink-soft uppercase">{label}</p>
        {icon && <span className={cn('text-slate-400', tone !== 'neutral' && accent)}>{icon}</span>}
      </div>
      <p className={cn('kpi-value', tone !== 'neutral' && accent)}>{value}</p>
      {sub && <p className="text-xs text-ink-soft">{sub}</p>}
    </Card>
  )
}

export function Progress({ value, tone = 'info' }: { value: number; tone?: 'info' | 'danger' | 'warning' | 'success' }) {
  const color = { info: 'bg-gov-700', danger: 'bg-red-600', warning: 'bg-amber-500', success: 'bg-emerald-600' }[tone]
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(value)}>
      <div className={cn('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? <IconCheck /> : <IconCopy />} {done ? 'Copied' : label}
    </button>
  )
}
