import type { DuplicateMatch as Match } from '../lib/duplicateEngine'
import { BAND_META, type MatchBand } from '../lib/duplicateEngine'
import { formatDate, cn, percent } from '../lib/utils'
import { Badge, Button, IconAlert, IconCheck, IconEye, IconSpinner, MatchBadge, Progress } from './ui'

const STATUS_ICON: Record<string, { icon: string; className: string }> = {
  match: { icon: '✓', className: 'text-emerald-700' },
  partial: { icon: '≈', className: 'text-amber-700' },
  mismatch: { icon: '✗', className: 'text-slate-400' },
  conflict: { icon: '!', className: 'text-red-700' },
  unknown: { icon: '?', className: 'text-slate-400' },
}

/** Explains WHY two records matched — never just "duplicate found". */
export function MatchReasons({ match, compact }: { match: Match; compact?: boolean }) {
  return (
    <ul className={cn('grid gap-x-4 gap-y-1', compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2')}>
      {match.score.reasons.map((r) => {
        const meta = STATUS_ICON[r.status] ?? STATUS_ICON.unknown
        return (
          <li key={r.field} className="flex items-start gap-2 text-[11px] leading-5">
            <span className={cn('mt-0.5 w-3 text-center font-bold', meta.className)} aria-hidden="true">{meta.icon}</span>
            <span className="min-w-0">
              <span className="font-semibold text-ink">{r.label}</span>
              <span className="text-ink-soft"> — {r.detail}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function MatchSummaryFlags({ match }: { match: Match }) {
  const f = match.score.flags
  return (
    <div className="flex flex-wrap gap-1.5">
      {f.identityMatch && <Badge tone="danger">Identical identity key</Badge>}
      {f.contactMatch && <Badge tone="info">Contact number matches</Badge>}
      {f.dobConflict && <Badge tone="warning">Birthdate conflict</Badge>}
      {f.sexConflict && <Badge tone="warning">Sex conflict</Badge>}
      {f.dobUnknown && <Badge tone="neutral">Birthdate missing</Badge>}
      {f.nameOnlyMatch && <Badge tone="warning">Name match on incomplete data</Badge>}
    </div>
  )
}

export function MatchCard({
  match, onUseExisting, onViewRecord, onMarkDifferent, actions = true, highlightBand,
}: {
  match: Match
  onUseExisting?: (m: Match) => void
  onViewRecord?: (m: Match) => void
  onMarkDifferent?: (m: Match) => void
  actions?: boolean
  highlightBand?: MatchBand
}) {
  const p = match.person
  const band = match.score.band
  const meta = BAND_META[band]
  const tone = meta.tone
  return (
    <div
      className={cn(
        'rounded-lg border p-3 sm:p-4',
        (highlightBand ? band === highlightBand : band === 'VERY_LIKELY') ? 'border-red-300 bg-red-50/40'
          : band === 'POSSIBLE' ? 'border-amber-300 bg-amber-50/40'
            : band === 'POTENTIAL' ? 'border-gov-200 bg-gov-50/40' : 'border-line bg-white',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-ink">
              {[p.first_name, p.middle_name, p.last_name, p.suffix].filter(Boolean).join(' ')}
            </p>
            <MatchBadge band={band} score={match.score.score} />
          </div>
          <dl className="mt-1 grid grid-cols-1 gap-x-4 text-[11px] text-ink-soft sm:grid-cols-2">
            <div><dt className="inline font-semibold">Barangay: </dt><dd className="inline">{p.barangay_name ?? '—'}</dd></div>
            <div><dt className="inline font-semibold">Birthdate: </dt><dd className="inline">{formatDate(p.date_of_birth)}</dd></div>
            <div><dt className="inline font-semibold">Purok/Sitio: </dt><dd className="inline">{p.purok ?? '—'}</dd></div>
            <div>
              <dt className="inline font-semibold">Reference: </dt>
              <dd className="inline mono">{'reference_no' in p ? String((p as { reference_no?: string }).reference_no ?? '—') : '—'}</dd>
            </div>
          </dl>
        </div>
        <div className="flex w-full max-w-[10rem] flex-col items-end gap-1">
          <span className="text-lg font-bold text-ink">{percent(match.score.score)}</span>
          <Progress value={match.score.score} tone={tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info'} />
          <span className="text-[10px] text-ink-soft">confidence</span>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-line bg-white/70 p-2.5">
        <p className="mb-1 text-[10px] font-semibold tracking-wide text-ink-soft uppercase">Why it matched</p>
        <MatchReasons match={match} compact />
      </div>

      <div className="mt-2.5">
        <MatchSummaryFlags match={match} />
      </div>

      {actions && (
        <div className="mt-3 flex flex-wrap gap-2">
          {onViewRecord && (
            <Button size="sm" variant="secondary" onClick={() => onViewRecord(match)}>
              <IconEye /> View record
            </Button>
          )}
          {onUseExisting && (
            <Button size="sm" variant="primary" onClick={() => onUseExisting(match)}>
              <IconCheck /> This is the same person
            </Button>
          )}
          {onMarkDifferent && (
            <Button size="sm" variant="ghost" onClick={() => onMarkDifferent(match)}>
              Different person
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The prominent live status strip required by the specification (section 22). */
export function LiveDuplicateIndicator({
  state, band, count, hasInput,
}: {
  state: 'idle' | 'checking' | 'done'
  band?: MatchBand | null
  count: number
  hasInput: boolean
}) {
  if (!hasInput) {
    return (
      <div className="rounded-md border border-dashed border-line bg-slate-50 px-3 py-2.5 text-xs text-ink-soft">
        Start typing a name — the registry is checked automatically before a record can be saved.
      </div>
    )
  }
  // 'idle' here means a name has been typed but the verdict has not arrived yet.
  // Showing a match band now would be misleading, so the strip stays neutral.
  if (state === 'checking' || state === 'idle') {
    return (
      <div className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs font-semibold',
        state === 'checking' ? 'border-gov-200 bg-gov-50 text-gov-900' : 'border-dashed border-line bg-slate-50 text-ink-soft',
      )}>
        <IconSpinner /> {state === 'checking' ? 'Checking existing records…' : 'Waiting to check the registry…'}
      </div>
    )
  }
  if (count === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs font-semibold text-emerald-900">
        <IconCheck /> No similar member found in the municipal registry. This looks like a new record.
      </div>
    )
  }
  const meta = BAND_META[(band ?? 'POTENTIAL') as MatchBand]
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2.5 text-xs',
        band === 'VERY_LIKELY' ? 'border-red-300 bg-red-50 text-red-900'
          : band === 'POSSIBLE' ? 'border-amber-300 bg-amber-50 text-amber-900'
            : 'border-gov-200 bg-gov-50 text-gov-900',
      )}
    >
      <p className="flex items-center gap-2 font-bold">
        <IconAlert />
        {band === 'VERY_LIKELY' ? '🔴 DUPLICATE LIKELY' : `⚠ ${meta.label}`}
      </p>
      <p className="mt-1">
        {count} possible match{count === 1 ? '' : 'es'} found. {meta.description}
      </p>
    </div>
  )
}
