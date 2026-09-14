import { useEffect, useState } from 'react'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from '../lib/duplicateEngine'
import { SUPABASE_ENABLED, SUPABASE_URL } from '../lib/supabase'
import { APP_BUILD } from '../lib/pwa'
import { cn } from '../lib/utils'
import {
  Badge, Button, Card, ConfirmDialog, Field, IconAlert, IconCloud, IconDownload, IconRefresh, IconSave,
  IconShieldCheck, Progress, useToast,
} from '../components/ui'

const WEIGHT_LABELS: Record<string, string> = {
  name: 'Name (first / last)',
  middle: 'Middle name',
  dob: 'Date of birth',
  sex: 'Sex',
  barangay: 'Barangay',
  purok: 'Purok / Sitio',
  address: 'Address',
  contact: 'Contact number',
}

export default function Settings() {
  const { api, user, settings, refreshSettings, connection, sync, lastSync, pendingCount, serverStatus, recheckServer } = useApp()
  const [checking, setChecking] = useState(false)
  const toast = useToast()
  const [weights, setWeights] = useState<Record<string, number>>({ ...DEFAULT_WEIGHTS })
  const [thresholds, setThresholds] = useState<Record<string, number>>({ ...DEFAULT_THRESHOLDS })
  const [system, setSystem] = useState({
    municipality: settings.municipality,
    province: settings.province,
    session_timeout_minutes: settings.session_timeout_minutes,
    mask_contact_in_lists: settings.mask_contact_in_lists,
    block_on_very_likely: settings.block_on_very_likely,
    require_reason_on_edit: settings.require_reason_on_edit,
  })
  const [busy, setBusy] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    setWeights({ ...DEFAULT_WEIGHTS, ...settings.weights })
    setThresholds({ ...DEFAULT_THRESHOLDS, ...settings.thresholds })
    setSystem({
      municipality: settings.municipality,
      province: settings.province,
      session_timeout_minutes: settings.session_timeout_minutes,
      mask_contact_in_lists: settings.mask_contact_in_lists,
      block_on_very_likely: settings.block_on_very_likely,
      require_reason_on_edit: settings.require_reason_on_edit,
    })
  }, [settings])

  const weightTotal = Object.values(weights).reduce((a, b) => a + Number(b || 0), 0)

  const save = async () => {
    setBusy(true)
    const res = await api.saveSettings({ weights, thresholds, system })
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Settings not saved', message: res.error })
      return
    }
    await refreshSettings()
    toast.push({ tone: 'success', title: 'Settings saved', message: 'New duplicate checks use these values immediately.' })
  }

  const backup = async () => {
    const persons = await api.personIndex()
    const payload = {
      exported_at: new Date().toISOString(),
      exported_by: user?.name,
      barangays: await api.listBarangays(true),
      persons,
      settings: { weights, thresholds, system },
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nmbr-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    await api.logEvent('BACKUP_EXPORTED', 'SYSTEM_SETTINGS', null, 'Registry backup', { records: persons.length })
    toast.push({ tone: 'success', title: 'Backup file created', message: `${persons.length} records written to JSON.` })
  }

  return (
    <>
      <PageHeader
        title="System Settings"
        subtitle="Matching behaviour, privacy defaults and the connection to the municipal server. Changing thresholds changes how strictly duplicates are blocked."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setResetting(true)}><IconRefresh /> Restore defaults</Button>
            <Button variant="primary" size="sm" loading={busy} onClick={() => void save()}><IconSave /> Save settings</Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* ---------------------------------------------- thresholds */}
          <Card>
            <div className="card-header">
              <h2 className="section-title">Duplicate thresholds</h2>
              <Badge tone="info">Simple percentage bands</Badge>
            </div>
            <div className="card-pad space-y-4">
              <ThresholdSlider
                label="Block the save (likely duplicate)"
                value={thresholds.block}
                min={90}
                max={100}
                hint="At or above this score the database refuses to create a second record and the encoder must use the existing one. Default 95%."
                onChange={(v) => setThresholds({ ...thresholds, block: v })}
                tone="danger"
              />
              <ThresholdSlider
                label="Warn the encoder (possible duplicate)"
                value={thresholds.warn}
                min={70}
                max={95}
                hint="Between this and the block threshold the encoder is shown the match and must confirm before saving. Default 80%."
                onChange={(v) => setThresholds({ ...thresholds, warn: v })}
                tone="warning"
              />
              <ThresholdSlider
                label="Show as a potential match"
                value={thresholds.notice}
                min={40}
                max={80}
                hint="Between this and the warning threshold the match is listed for information only. Default 60%."
                onChange={(v) => setThresholds({ ...thresholds, notice: v })}
                tone="info"
              />
              <div className="rounded-md border border-line bg-slate-50 p-3 text-[11px] text-ink-soft">
                Below {thresholds.notice}% records are treated as different people.
                Current bands: <span className="font-semibold text-red-700">≥{thresholds.block}% blocked</span> ·{' '}
                <span className="font-semibold text-amber-700">{thresholds.warn}–{thresholds.block - 1}% warned</span> ·{' '}
                <span className="font-semibold text-gov-800">{thresholds.notice}–{thresholds.warn - 1}% informational</span>.
              </div>
            </div>
          </Card>

          {/* ---------------------------------------------- weights */}
          <Card>
            <div className="card-header">
              <h2 className="section-title">Matching weights</h2>
              <Badge tone={weightTotal === 100 ? 'success' : 'warning'}>Total {weightTotal}</Badge>
            </div>
            <div className="card-pad space-y-4">
              {Object.keys(WEIGHT_LABELS).map((key) => (
                <div key={key}>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-ink" htmlFor={`weight-${key}`}>{WEIGHT_LABELS[key]}</label>
                    <span className="text-xs font-semibold text-ink-soft">{weights[key] ?? 0} pts</span>
                  </div>
                  <input
                    id={`weight-${key}`}
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={weights[key] ?? 0}
                    onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
                    className="mt-1 w-full accent-gov-800"
                  />
                </div>
              ))}
              {weightTotal !== 100 && (
                <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                  <IconAlert className="mt-0.5" />
                  Weights should add up to 100 so the score stays a true percentage. The engine normalises whatever you
                  set, but round numbers are easier to explain to staff.
                </p>
              )}
              <p className="text-[11px] text-ink-soft">
                The identity guard (normalised name + birthdate) always blocks a second master record regardless of
                these weights — it is the database-level protection against simultaneous submissions.
              </p>
            </div>
          </Card>

          {/* ---------------------------------------------- system */}
          <Card>
            <div className="card-header"><h2 className="section-title">Municipality and privacy</h2></div>
            <div className="card-pad grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Municipality">
                <input className="input" value={system.municipality} onChange={(e) => setSystem({ ...system, municipality: e.target.value })} />
              </Field>
              <Field label="Province">
                <input className="input" value={system.province} onChange={(e) => setSystem({ ...system, province: e.target.value })} />
              </Field>
              <Field label="Session timeout (minutes)" hint="Sign-in ends after this much inactivity.">
                <input
                  className="input" type="number" min={5} max={480}
                  value={system.session_timeout_minutes}
                  onChange={(e) => setSystem({ ...system, session_timeout_minutes: Number(e.target.value) })}
                />
              </Field>
              <div className="space-y-2 sm:col-span-2">
                <Toggle
                  label="Mask contact numbers in list views"
                  hint="Full numbers remain visible on the member profile, where access is logged."
                  checked={system.mask_contact_in_lists}
                  onChange={(v) => setSystem({ ...system, mask_contact_in_lists: v })}
                />
                <Toggle
                  label="Block a save when a likely duplicate is found"
                  hint="Recommended. Turning this off allows records to be parked for review instead of refused."
                  checked={system.block_on_very_likely}
                  onChange={(v) => setSystem({ ...system, block_on_very_likely: v })}
                />
                <Toggle
                  label="Require a reason when editing a record"
                  hint="Every edit is stored with the previous and new values plus this reason."
                  checked={system.require_reason_on_edit}
                  onChange={(v) => setSystem({ ...system, require_reason_on_edit: v })}
                />
              </div>
            </div>
          </Card>
        </div>

        {/* ---------------------------------------------- side */}
        <div className="space-y-4">
          <Card className="card-pad">
            <h2 className="section-title"><IconCloud /> Municipal server</h2>
            <div className="mt-3 space-y-2 text-xs">
              <Row label="Mode" value={SUPABASE_ENABLED ? 'Supabase configured' : 'Standalone (local registry only)'} />
              <Row label="Connection" value={connection === 'online' ? 'Online' : connection === 'offline' ? 'Offline' : connection === 'unknown' ? 'Checking…' : 'Not configured'} />
              <Row
                label="Database"
                value={
                  <Badge tone={serverStatus === 'ready' ? 'success' : serverStatus === 'missing' ? 'warning' : 'muted'}>
                    {serverStatus === 'ready' ? 'Set up and ready'
                      : serverStatus === 'missing' ? 'Not set up yet'
                        : serverStatus === 'unconfigured' ? 'Not configured' : 'Not checked'}
                  </Badge>
                }
              />
              <Row label="Endpoint" value={<span className="mono text-[10px]">{SUPABASE_URL.replace('https://', '')}</span>} />
              <Row label="App build" value={<span className="mono text-[10px]">{APP_BUILD}</span>} />
              <Row label="Queued changes" value={String(pendingCount)} />
              <Row label="Last synchronised" value={lastSync ? new Date(lastSync).toLocaleString() : 'never'} />
            </div>

            {serverStatus === 'missing' && (
              <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-900">
                <p className="font-semibold">The database has not been created on this Supabase project.</p>
                <p className="mt-1">
                  Run the setup SQL once and the whole registry switches to the central database; queued work uploads
                  by itself. Steps and the full guide are in the download below.
                </p>
              </div>
            )}

            <div className="mt-3 flex flex-col gap-2">
              <Button
                variant="secondary"
                loading={checking}
                onClick={async () => { setChecking(true); await recheckServer(); setChecking(false) }}
              >
                <IconRefresh /> Check the server again
              </Button>
              {SUPABASE_ENABLED && (
                <>
                  <a className="btn btn-secondary btn-sm" href="/setup/NMBR-supabase-setup.sql" download>
                    <IconDownload /> Database setup SQL
                  </a>
                  <a className="btn btn-ghost btn-sm" href="/setup/NMBR-demonstration-data.sql" download>
                    <IconDownload /> Demonstration data (optional)
                  </a>
                </>
              )}
              <Button variant="primary" onClick={() => void sync()}>
                <IconCloud /> Synchronise now
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-ink-soft">
              Paste the setup SQL into the Supabase SQL Editor once, then press “Check the server again”. Until then the
              registry runs on this device and nothing is lost; afterwards reads and writes go to the server, offline
              entries replay automatically, and a queued entry that clashes with the server is parked as a conflict for
              you to resolve.
            </p>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title"><IconShieldCheck /> Data protection</h2>
            <ul className="mt-2 space-y-1.5 text-[11px] text-ink-soft">
              <li>Access to member data requires an authenticated municipal account.</li>
              <li>Row-level security keeps every request attributed to a real user.</li>
              <li>Records are archived, never deleted, so history cannot be rewritten.</li>
              <li>Exports are written to the audit log with the row count.</li>
              <li>The application is not indexed by search engines and has no public pages.</li>
            </ul>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title">Backup</h2>
            <p className="mt-2 text-[11px] text-ink-soft">
              Download a JSON snapshot of the registry for archival. Restoring is done by an administrator using the
              import workflow so every restored row is checked for duplicates.
            </p>
            <Button variant="secondary" className="mt-3 w-full" onClick={() => void backup()}>
              <IconDownload /> Download backup (JSON)
            </Button>
            <p className="mt-2 text-[11px] text-ink-soft">
              {pendingCount > 0
                ? `${pendingCount} queued change(s) are not yet on the server — synchronise first for a complete backup.`
                : 'Everything is in sync with the server.'}
            </p>
          </Card>

          <Card className="card-pad">
            <h2 className="section-title">Matching health</h2>
            <div className="mt-3 space-y-2">
              <div>
                <div className="flex justify-between text-[11px]"><span className="text-ink-soft">Blocking strictness</span><span className="font-semibold">{thresholds.block}%</span></div>
                <Progress value={thresholds.block} tone="danger" />
              </div>
              <div>
                <div className="flex justify-between text-[11px]"><span className="text-ink-soft">Warning strictness</span><span className="font-semibold">{thresholds.warn}%</span></div>
                <Progress value={thresholds.warn} tone="warning" />
              </div>
              <div>
                <div className="flex justify-between text-[11px]"><span className="text-ink-soft">Informational floor</span><span className="font-semibold">{thresholds.notice}%</span></div>
                <Progress value={thresholds.notice} tone="info" />
              </div>
            </div>
            <p className="mt-3 text-[11px] text-ink-soft">
              If encoders complain about too many warnings, raise the informational floor first. Never lower the
              blocking threshold below 90% — that is what allows duplicate master records to slip through.
            </p>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={resetting}
        title="Restore the default matching settings?"
        message="The weights and thresholds return to the values recommended for a municipal registry. Barangays, member records and duplicate cases are not touched."
        confirmLabel="Restore defaults"
        tone="warning"
        onClose={() => setResetting(false)}
        onConfirm={() => {
          setWeights({ ...DEFAULT_WEIGHTS })
          setThresholds({ ...DEFAULT_THRESHOLDS })
          setResetting(false)
          toast.push({ tone: 'info', title: 'Defaults loaded', message: 'Press Save settings to apply them.' })
        }}
      />
    </>
  )
}

function ThresholdSlider({
  label, value, min, max, hint, onChange, tone,
}: {
  label: string; value: number; min: number; max: number; hint: string
  onChange: (v: number) => void; tone: 'danger' | 'warning' | 'info'
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-ink">{label}</label>
        <span className={cn('text-sm font-bold', tone === 'danger' ? 'text-red-700' : tone === 'warning' ? 'text-amber-700' : 'text-gov-800')}>
          {value}%
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn('mt-1 w-full', tone === 'danger' ? 'accent-red-600' : tone === 'warning' ? 'accent-amber-500' : 'accent-gov-800')}
      />
      <p className="mt-1 text-[11px] text-ink-soft">{hint}</p>
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-3">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="text-[11px] text-ink-soft">{hint}</span>
      </span>
    </label>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  )
}
