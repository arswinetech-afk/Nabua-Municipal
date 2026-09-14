import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import type { OutboxItem } from '../lib/types'
import { cn, formatDateTime, relativeTime } from '../lib/utils'
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, IconAlert, IconCheck, IconCloud, IconRefresh,
  IconSpinner, IconTrash, IconWifiOff, KpiCard, StatusBadge, useToast,
} from '../components/ui'

const STATUS_TONE: Record<string, string> = {
  PENDING: 'warning', SYNCING: 'info', DONE: 'success', FAILED: 'danger', CONFLICT: 'danger',
}

export default function SyncCentre() {
  const { api, online, sync, pendingCount, lastSync, refreshPending, connection, usingServer } = useApp()
  const navigate = useNavigate()
  const toast = useToast()
  const [items, setItems] = useState<OutboxItem[]>([])
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState<OutboxItem | null>(null)

  const load = () => {
    setItems(api.pendingChanges().slice().reverse())
    refreshPending()
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connection])

  const run = async () => {
    setBusy(true)
    await sync()
    load()
    setBusy(false)
  }

  const retryOne = async (_item: OutboxItem) => {
    setBusy(true)
    await sync()
    load()
    setBusy(false)
  }

  const queued = items.filter((i) => i.status === 'PENDING' || i.status === 'SYNCING')
  const conflicts = items.filter((i) => i.status === 'CONFLICT')
  const failed = items.filter((i) => i.status === 'FAILED')
  const done = items.filter((i) => i.status === 'DONE')

  return (
    <>
      <PageHeader
        title="Sync Centre"
        subtitle="Changes made while offline are queued here and sent to the municipal server automatically. Nothing is ever discarded without a decision."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={load}><IconRefresh /> Reload queue</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={!online} onClick={() => void run()}>
              <IconCloud /> Synchronise now
            </Button>
          </>
        }
      />

      {!online && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <IconWifiOff className="mt-0.5" />
          <span>
            The municipal server is unreachable. Encoding, searching and duplicate checking continue to work against the
            local registry copy; queued changes are sent as soon as the connection returns.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Waiting to send" value={queued.length} sub="Queued on this device" tone={queued.length ? 'warning' : 'success'} icon={<IconCloud />} />
        <KpiCard label="Needs your decision" value={conflicts.length} sub="The server found a clash" tone={conflicts.length ? 'danger' : 'success'} icon={<IconAlert />} />
        <KpiCard label="Failed attempts" value={failed.length} sub="Will retry automatically" tone={failed.length ? 'warning' : 'neutral'} />
        <KpiCard label="Sent" value={done.length} sub={lastSync ? `Last sync ${relativeTime(lastSync)}` : 'Not synced yet'} tone="success" icon={<IconCheck />} />
      </div>

      <Card className="card-pad mt-4">
        <h2 className="section-title">Connection</h2>
        <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-soft">Status</span>
            <Badge tone={online ? 'success' : 'warning'}>{online ? 'Online' : 'Offline'}</Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-soft">Data source</span>
            <Badge tone={usingServer ? 'info' : 'muted'}>{usingServer ? 'Municipal server' : 'Local registry copy'}</Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-soft">Queued changes</span>
            <span className="font-semibold text-ink">{pendingCount}</span>
          </div>
        </div>
      </Card>

      {conflicts.length > 0 && (
        <Card className="mt-4 border-red-200">
          <div className="card-header">
            <h2 className="section-title text-red-800"><IconAlert /> Conflicts needing a decision</h2>
          </div>
          <ul className="divide-y divide-line">
            {conflicts.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{c.summary}</p>
                    <p className="mt-0.5 text-[11px] text-ink-soft">
                      Queued {formatDateTime(c.created_at)} · {c.operation}
                    </p>
                    {c.error && (
                      <p className="mt-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800">
                        {c.error}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" loading={busy} onClick={() => void retryOne(c)}>Retry</Button>
                    <Button size="sm" variant="ghost" onClick={() => navigate('/duplicates')}>Review duplicates</Button>
                    <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setDiscarding(c)}>
                      <IconTrash /> Discard
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-4 py-3 text-[11px] text-ink-soft">
            A conflict means the entry you made offline now clashes with the server — usually because another encoder
            created the same resident in the meantime. Open the member in the Duplicate Center, decide which record
            survives, then discard this queued copy.
          </p>
        </Card>
      )}

      <Card className="mt-4">
        <div className="card-header">
          <h2 className="section-title">Queued and recent changes</h2>
          <span className="text-[11px] text-ink-soft">{items.length} item(s)</span>
        </div>
        {items.length === 0 ? (
          <EmptyState
            icon={<IconCheck className="h-6 w-6 text-emerald-600" />}
            title="Nothing is queued"
            message="Every change on this device has already reached the municipal server."
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className={cn('flex flex-wrap items-start justify-between gap-2 px-4 py-3',
                item.status === 'CONFLICT' && 'bg-red-50/40')}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{item.summary}</p>
                  <p className="mt-0.5 text-[11px] text-ink-soft">
                    {item.operation} · queued {relativeTime(item.created_at)} · {item.attempts} attempt(s)
                    {item.error ? ` · ${item.error}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={item.status} />
                  <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>{item.status.toLowerCase()}</Badge>
                  {(item.status === 'PENDING' || item.status === 'FAILED') && (
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => void retryOne(item)}>
                      <IconSpinner /> Retry
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="card-pad mt-4">
        <h2 className="section-title">How offline work is protected</h2>
        <ul className="mt-2 grid grid-cols-1 gap-2 text-[11px] text-ink-soft sm:grid-cols-2">
          <li>Saves are applied locally first when the server cannot be reached, so an entry is never lost.</li>
          <li>Each queued item is replayed in order, with the same authorisation as an online save.</li>
          <li>The server still refuses a duplicate — a rejected item becomes a conflict instead of disappearing.</li>
          <li>The identity guard runs again on the server, so a duplicate cannot be created by two offline devices.</li>
        </ul>
      </Card>

      <ConfirmDialog
        open={!!discarding}
        title="Discard this queued change?"
        message="The change will not be sent to the municipal server. If it created a member locally, review that record afterwards — nothing is removed from the server by this action."
        confirmLabel="Discard the queued change"
        tone="danger"
        requireReason
        onClose={() => setDiscarding(null)}
        onConfirm={async (reason) => {
          if (discarding) {
            await api.discardPending(discarding.id)
            await api.logEvent('SYNC_ITEM_DISCARDED', 'SYSTEM_SETTINGS', discarding.id, discarding.summary, null, reason)
            toast.push({ tone: 'info', title: 'Queued change discarded', message: 'The reason was written to the audit log.' })
          }
          setDiscarding(null)
          load()
        }}
      />
    </>
  )
}
