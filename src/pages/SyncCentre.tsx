import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import type { OutboxItem } from '../lib/types'
import { WAITING_FOR_SIGNIN_MESSAGE } from '../lib/apiClient'
import { cn, formatDateTime, relativeTime } from '../lib/utils'
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, IconAlert, IconCheck, IconCloud, IconDownload,
  IconRefresh, IconSpinner, IconTrash, IconWifiOff, KpiCard, useToast,
} from '../components/ui'

const STATUS_TONE: Record<string, string> = {
  PENDING: 'warning', SYNCING: 'info', DONE: 'success', FAILED: 'danger', CONFLICT: 'danger',
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'waiting to send', SYNCING: 'sending…', DONE: 'sent',
  FAILED: 'failed', CONFLICT: 'needs your decision',
}

export default function SyncCentre() {
  const { api, online, sync, pendingCount, lastSync, refreshPending, connection, usingServer, serverStatus, recheckServer, needsSignIn } = useApp()
  const navigate = useNavigate()
  const toast = useToast()
  const [items, setItems] = useState<OutboxItem[]>([])
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState<OutboxItem | null>(null)
  const [checking, setChecking] = useState(false)
  /** Supabase answers, but the NMBR tables and functions have not been created. */
  const notProvisioned = serverStatus === 'missing'

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
  const waitingForSignIn = needsSignIn || items.some((i) => i.status === 'PENDING' && i.error === WAITING_FOR_SIGNIN_MESSAGE)
  const checkAgain = async () => {
    setChecking(true)
    await recheckServer()
    load()
    setChecking(false)
  }
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

      {notProvisioned && (
        <Card className="card-pad mb-4 border-amber-300 bg-amber-50/60">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-bold text-amber-900">
                <IconAlert /> The municipal database has not been set up yet
              </h2>
              <p className="mt-1 max-w-2xl text-xs text-amber-900">
                Supabase is reachable and the sign-in works, but the NMBR tables and functions have not been created on
                it yet, so nothing has been uploaded. This is <span className="font-semibold">not a data loss</span>:
                every change below is safe on this device and uploads by itself once the setup is done.
              </p>
              <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-amber-900">
                <li>Download the setup SQL below (it contains the whole database definition).</li>
                <li>Open the Supabase project → <span className="font-semibold">SQL Editor</span> → paste the file → <span className="font-semibold">Run</span>.</li>
                <li>Come back here and press <span className="font-semibold">Check the server again</span> — the queue uploads on its own.</li>
              </ol>
            </div>
            <div className="flex flex-col gap-2">
              <a className="btn btn-primary btn-sm" href="/setup/NMBR-supabase-setup.sql" download>
                <IconDownload /> Download setup SQL
              </a>
              <a className="btn btn-secondary btn-sm" href="/setup/NMBR-demonstration-data.sql" download>
                <IconDownload /> Optional: demonstration data
              </a>
              <Button variant="secondary" size="sm" loading={checking} onClick={() => void checkAgain()}>
                <IconRefresh /> Check the server again
              </Button>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-amber-900">
            Until then the registry runs entirely on this device: search, encoding and duplicate checking all keep
            working, and the duplicate rules are enforced locally exactly as the database enforces them.
            See <span className="mono">docs/DEPLOY_CLOUDFLARE.md</span> for the full deployment steps.
          </p>
        </Card>
      )}

      {waitingForSignIn && !notProvisioned && (
        <Card className="card-pad mb-4 border-rose-300 bg-rose-50/60">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-bold text-rose-900">
                <IconAlert /> These changes are waiting for a sign-in, not failing
              </h2>
              <p className="mt-1 max-w-2xl text-xs text-rose-900">
                The municipal server is reachable and set up, but it does not recognise a session from this
                device — usually because the sign-in fell back to the on-device registry, or the session
                expired mid-shift. Retrying cannot fix that, so the queue is <span className="font-semibold">parked
                safely on this device</span> and no more attempts are counted. Sign in with your office account
                and everything below uploads by itself, in order.
              </p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-rose-900">
                <li>Nothing is lost: every change below stays on this device until it is accepted by the server.</li>
                <li>Encoding, search and duplicate checking keep working while you wait.</li>
                <li>If the queue previously showed “Your session is not recognised”, that was this state.</li>
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <Button variant="primary" size="sm" onClick={() => navigate('/login?reauth=1')}>
                <IconCheck /> Sign in to upload the queue
              </Button>
              <Button variant="secondary" size="sm" onClick={load}>
                <IconRefresh /> Reload queue
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={notProvisioned ? 'Waiting for server setup' : waitingForSignIn ? 'Waiting for sign-in' : 'Waiting to send'}
          value={queued.length}
          sub={notProvisioned ? 'Safe on this device' : 'Queued on this device'}
          tone={queued.length ? 'warning' : 'success'}
          icon={<IconCloud />}
        />
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
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-soft">Municipal database</span>
            <Badge tone={serverStatus === 'ready' ? 'success' : serverStatus === 'missing' ? 'warning' : 'muted'}>
              {serverStatus === 'ready' ? 'Set up'
                : serverStatus === 'missing' ? 'Not set up yet'
                  : serverStatus === 'unconfigured' ? 'Not configured' : 'Checking…'}
            </Badge>
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
            {items.map((item) => {
              const parkedForSignIn = item.status === 'PENDING' && item.error === WAITING_FOR_SIGNIN_MESSAGE
              return (
                <li key={item.id} className={cn('flex flex-wrap items-start justify-between gap-2 px-4 py-3',
                  item.status === 'CONFLICT' && 'bg-red-50/40')}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{item.summary}</p>
                    <p className="mt-0.5 text-[11px] text-ink-soft">
                      {item.operation} · queued {relativeTime(item.created_at)}
                      {!notProvisioned && !parkedForSignIn && ` · ${item.attempts} attempt(s)`}
                    </p>
                    {item.error && (
                      <p className={cn('mt-1 text-[11px]',
                        parkedForSignIn || (notProvisioned && item.status === 'PENDING') ? 'text-amber-800' : 'text-red-700')}>
                        {parkedForSignIn
                          ? 'Waiting for a sign-in to the municipal server — no retries are being burned, and nothing is lost.'
                          : notProvisioned && item.status === 'PENDING'
                            ? 'Waiting for the municipal database to be set up — no action needed.'
                            : item.error}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={parkedForSignIn ? 'warning' : STATUS_TONE[item.status] ?? 'neutral'}>
                      {parkedForSignIn
                        ? 'waiting for sign-in'
                        : notProvisioned && item.status === 'PENDING'
                          ? 'waiting for server setup'
                          : STATUS_LABEL[item.status] ?? item.status.toLowerCase()}
                    </Badge>
                    {parkedForSignIn ? (
                      <Button size="sm" variant="secondary" onClick={() => navigate('/login?reauth=1')}>
                        Sign in
                      </Button>
                    ) : (
                      (item.status === 'PENDING' || item.status === 'FAILED') && !notProvisioned && (
                        <Button size="sm" variant="ghost" loading={busy} onClick={() => void retryOne(item)}>
                          <IconSpinner /> Retry
                        </Button>
                      )
                    )}
                  </div>
                </li>
              )
            })}
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
