import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../state/AppProvider'
import { PageHeader } from '../components/Layout'
import { DataTable, type Column } from '../components/DataTable'
import type { ManagedUser } from '../lib/types'
import { ROLE_LABEL, type UserRole } from '../lib/types'
import { formatDateTime, relativeTime } from '../lib/utils'
import {
  Badge, Button, Card, ConfirmDialog, Field, IconAlert, IconCheck, IconEdit, IconPlus, IconRefresh,
  IconShieldCheck, IconUsers, KpiCard, Modal, StatusBadge, useToast,
} from '../components/ui'

/**
 * The allow / deny matrix mirrors the database policies exactly. If this list and
 * the SQL ever disagree, the database wins — the UI only shows what is allowed.
 */
const PERMISSIONS: Array<{ area: string; encoder: string; admin: string; sysadmin: string; viewer: string }> = [
  { area: 'View member records', encoder: '✅', admin: '✅', sysadmin: '✅', viewer: '✅' },
  { area: 'Search the full municipal registry', encoder: '✅', admin: '✅', sysadmin: '✅', viewer: '✅' },
  { area: 'Add a member (search-before-add enforced)', encoder: '✅', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Edit member details (reason required)', encoder: '✅', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Transfer a barangay assignment', encoder: '✅', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Change a record status', encoder: '✅', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Review and merge duplicates', encoder: '⛔', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Bulk import (Excel / CSV)', encoder: '⛔', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Export lists to CSV', encoder: '✅', admin: '✅', sysadmin: '✅', viewer: '✅' },
  { area: 'View the audit log', encoder: '✅ (own entries)', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Manage users and roles', encoder: '⛔', admin: '✅ (except SYSTEM_ADMIN)', sysadmin: '✅', viewer: '⛔' },
  { area: 'Manage barangays', encoder: '⛔', admin: '✅', sysadmin: '✅', viewer: '⛔' },
  { area: 'Change matching weights and thresholds', encoder: '⛔', admin: '⛔', sysadmin: '✅', viewer: '⛔' },
  { area: 'Delete a record permanently', encoder: '⛔', admin: '⛔', sysadmin: '⛔ (archive only)', viewer: '⛔' },
]

export default function Users() {
  const { api, user } = useApp()
  const toast = useToast()
  const [rows, setRows] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ManagedUser | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<{ name: string; email: string; role: UserRole; active: boolean; barangay_scope: string }>({
    name: '', email: '', role: 'ENCODER', active: true, barangay_scope: '',
  })
  const [busy, setBusy] = useState(false)
  const [deactivating, setDeactivating] = useState<ManagedUser | null>(null)

  const canManage = user && ['ADMINISTRATOR', 'SYSTEM_ADMIN'].includes(user.role)
  const isSysAdmin = user?.role === 'SYSTEM_ADMIN'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await api.listUsers())
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const openForm = (u?: ManagedUser) => {
    if (u) {
      setForm({ name: u.name, email: u.email, role: u.role, active: u.active, barangay_scope: u.barangay_scope ?? '' })
      setEditing(u)
      return
    }
    setForm({ name: '', email: '', role: 'ENCODER', active: true, barangay_scope: '' })
    setCreating(true)
  }

  const save = async () => {
    if (!form.name.trim() || !form.email.trim()) return
    setBusy(true)
    const res = await api.upsertUser({
      id: editing?.id, name: form.name.trim(), email: form.email.trim().toLowerCase(),
      role: form.role, active: form.active, barangay_scope: form.barangay_scope || null,
    } as Partial<ManagedUser> & { name: string; email: string; role: string })
    setBusy(false)
    if (!res.ok) {
      toast.push({ tone: 'error', title: 'Could not save the account', message: res.error })
      return
    }
    toast.push({
      tone: 'success',
      title: editing ? 'Account updated' : 'Account created',
      message: editing ? 'The change is recorded in the audit log.' : 'Share the sign-in details securely with the staff member.',
    })
    setEditing(null)
    setCreating(false)
    await load()
  }

  const toggleActive = async (reason: string) => {
    if (!deactivating) return
    setBusy(true)
    const res = await api.upsertUser({
      id: deactivating.id, name: deactivating.name, email: deactivating.email, role: deactivating.role,
      active: !deactivating.active,
    } as Partial<ManagedUser> & { name: string; email: string; role: string })
    if (res.ok) {
      await api.logEvent(deactivating.active ? 'USER_DEACTIVATED' : 'USER_REACTIVATED', 'USERS',
        deactivating.id, deactivating.name, { active: !deactivating.active }, reason || null)
      toast.push({ tone: 'success', title: `Account ${deactivating.active ? 'deactivated' : 'reactivated'}` })
      await load()
    } else {
      toast.push({ tone: 'error', title: 'Could not update the account', message: res.error })
    }
    setBusy(false)
    setDeactivating(null)
  }

  const columns: Array<Column<ManagedUser>> = [
    {
      key: 'name', header: 'Staff member', value: (u) => u.name,
      render: (u) => (
        <div>
          <p className="text-sm font-semibold text-ink">{u.name}</p>
          <p className="text-[11px] text-ink-soft">{u.email}</p>
        </div>
      ),
    },
    { key: 'role', header: 'Role', value: (u) => u.role,
      render: (u) => <Badge tone={u.role === 'SYSTEM_ADMIN' ? 'danger' : u.role === 'ADMINISTRATOR' ? 'info' : u.role === 'VIEWER' ? 'muted' : 'neutral'}>{ROLE_LABEL[u.role]}</Badge> },
    { key: 'status', header: 'Status', value: (u) => (u.active ? 'Active' : 'Inactive'),
      render: (u) => <Badge tone={u.active ? 'success' : 'muted'}>{u.active ? 'Active' : 'Inactive'}</Badge> },
    { key: 'last_login', header: 'Last sign-in', value: (u) => u.last_login ?? '',
      render: (u) => <span className="text-xs text-ink-soft">{u.last_login ? `${relativeTime(u.last_login)}` : 'never'}</span> },
    { key: 'created', header: 'Created', value: (u) => u.created_at, defaultHidden: true,
      render: (u) => <span className="text-[11px] text-ink-soft">{formatDateTime(u.created_at)}</span> },
    {
      key: 'actions', header: 'Actions', value: () => '', sortable: false,
      render: (u) => (canManage ? (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="secondary" onClick={() => openForm(u)}><IconEdit /> Edit</Button>
          {isSysAdmin && u.id !== user?.id && (
            <Button size="sm" variant="ghost" className={u.active ? 'text-red-700' : 'text-emerald-700'} onClick={() => setDeactivating(u)}>
              {u.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
        </div>
      ) : <span className="text-[11px] text-ink-soft">Read-only</span>),
    },
  ]

  return (
    <>
      <PageHeader
        title="User Accounts"
        subtitle="Only municipal staff may reach the registry. Roles decide what each account can do, and the database enforces the same rules."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}><IconRefresh /> Refresh</Button>
            {canManage && <Button variant="primary" size="sm" onClick={() => openForm()}><IconPlus /> Add account</Button>}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Accounts" value={rows.length} sub={`${rows.filter((u) => u.active).length} active`} icon={<IconUsers />} />
        <KpiCard label="Encoders" value={rows.filter((u) => u.role === 'ENCODER').length} sub="Data entry staff" />
        <KpiCard label="Administrators" value={rows.filter((u) => u.role === 'ADMINISTRATOR').length} sub="Duplicate review, imports, users" />
        <KpiCard label="System administrators" value={rows.filter((u) => u.role === 'SYSTEM_ADMIN').length} sub="Matching settings and full control" />
      </div>

      <div className="mt-4">
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(u) => u.id}
          loading={loading}
          exportName="user-accounts"
          mobilePrimary={['name', 'role']}
          emptyTitle="No accounts yet"
          emptyMessage="Create the first account so staff can sign in."
        />
      </div>

      <Card className="card-pad mt-4">
        <h2 className="section-title"><IconShieldCheck /> Retiring an account: deactivate, never delete</h2>
        <p className="mt-1 text-[11px] text-ink-soft">
          Every audit entry, member record and duplicate decision keeps a pointer to the profile that
          created it, and the audit log is immutable by law-grade design (RA 10173). Deleting a profile
          would force those pointers to null — a rewrite of history — so the database refuses it
          (NMBR_AUDIT_IMMUTABLE). Deactivation is the supported retirement: the profile stays in the
          ledger, can no longer sign in or be linked, and can be reactivated if the person returns.
          You cannot deactivate your own row while signed in as it — ask the other system administrator.
          The rare physical deletion (with its consequences) is documented in docs/GO_LIVE.md §4c.
        </p>
      </Card>

      <Card className="card-pad mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title"><IconShieldCheck /> Role permissions</h2>
          <p className="text-[11px] text-ink-soft">Enforced in PostgreSQL as well as in this table.</p>
        </div>
        <div className="table-wrap mt-3">
          <table className="table">
            <thead>
              <tr>
                <th>Capability</th><th>Encoder</th><th>Administrator</th><th>System administrator</th><th>Viewer</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p.area}>
                  <td className="text-xs font-medium text-ink">{p.area}</td>
                  <td className="text-xs">{p.encoder}</td>
                  <td className="text-xs">{p.admin}</td>
                  <td className="text-xs">{p.sysadmin}</td>
                  <td className="text-xs">{p.viewer}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 flex items-start gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
          <IconAlert className="mt-0.5" />
          No role can permanently delete a member record. Records are archived with a reason and stay readable in the
          audit trail, which is what keeps the registry defensible.
        </p>
      </Card>

      <Modal
        open={creating || !!editing}
        onClose={() => { setCreating(false); setEditing(null) }}
        title={editing ? `Edit ${editing.name}` : 'Add a staff account'}
        description="Accounts are never deleted — deactivate them so the audit trail stays complete."
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCreating(false); setEditing(null) }}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!form.name.trim() || !form.email.trim()} onClick={() => void save()}>
              <IconCheck /> Save account
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Full name" required>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Maria Santos" />
          </Field>
          <Field label="Official email" required hint="Used as the sign-in name.">
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="maria.santos@nabua.gov.ph" />
          </Field>
          <Field label="Role" required>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}>
              {(['ENCODER', 'ADMINISTRATOR', 'SYSTEM_ADMIN', 'VIEWER'] as UserRole[])
                .filter((r) => isSysAdmin || r !== 'SYSTEM_ADMIN')
                .map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </Field>
          <Field label="Barangay scope" hint="Optional. Leave blank for municipal-wide access.">
            <input className="input" value={form.barangay_scope} onChange={(e) => setForm({ ...form, barangay_scope: e.target.value })} placeholder="e.g. San Isidro only" />
          </Field>
          <label className="flex items-center gap-2 text-xs font-medium">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Account is active and may sign in
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deactivating}
        title={deactivating?.active ? `Deactivate ${deactivating?.name}?` : `Reactivate ${deactivating?.name}?`}
        message={
          deactivating?.active
            ? 'The account can no longer sign in. Records they created stay attributed to them, and the audit trail is untouched.'
            : 'The staff member will be able to sign in again with their existing credentials.'
        }
        confirmLabel={deactivating?.active ? 'Deactivate' : 'Reactivate'}
        tone={deactivating?.active ? 'warning' : 'primary'}
        requireReason={!!deactivating?.active}
        onClose={() => setDeactivating(null)}
        onConfirm={(reason) => void toggleActive(reason)}
      />

      <Card className="card-pad mt-4">
        <h2 className="section-title">Session policy</h2>
        <p className="mt-2 text-xs text-ink-soft">
          Sessions end after a period of inactivity configured in Settings, and the sign-in screen is the only public
          page in the application. There is no public member search — every lookup requires an authenticated municipal
          account.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusBadge status="ACTIVE" />
          <Badge tone="info">Timeout enforced by the app</Badge>
          <Badge tone="muted">No self-registration</Badge>
        </div>
      </Card>
    </>
  )
}
