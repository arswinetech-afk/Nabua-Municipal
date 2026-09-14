# NMBR — Nabua Municipal Barangay Registry

**Centralized Member Registry & Duplicate Prevention System** for the Municipality of Nabua, Camarines Sur.

One person = one master record. Residents are registered once in a central registry; barangays are a
location on that record, not a separate database. Encoders are warned about an existing member
*before* a new record can be saved, and PostgreSQL refuses simultaneous duplicates outright.

---

## What is in this repository

| Path | Contents |
| --- | --- |
| `src/pages/` | The screens: Dashboard, Barangay Directory, Barangay Registry, Member Registry, Add Member (search-before-add), Member Profile, Duplicate Review Center, Data Quality, Bulk Import, Audit Logs, Reports, Users, Settings, Sync Centre. |
| `src/components/` | Shared UI: layout shell, sortable/filterable data table, duplicate match cards with per-field explanations, modals, toasts, skeletons. |
| `src/lib/` | Domain logic: normalisation and fuzzy matching, duplicate engine and bands, the `RegistryApi` contract with its PostgreSQL and offline implementations, the outbox/online-offline switch, CSV/XLSX helpers. |
| `supabase/migrations/` | The database: schema, matching functions, duplicate guard triggers, registry/duplicate/import RPCs and row-level security. Idempotent, applied in order. |
| `supabase/seed.sql`, `src/data/seed.json` | Demonstration data: 12 barangays, 160 fictional members with intentional duplicate cases. |
| `scripts/` | `pg-selftest.mjs` (84 rule assertions against an embedded PostgreSQL), `pg-seed-test.mjs` (seed integrity), `gen-seed.mjs` (single source for the seed). |
| `tests/` | UI acceptance tests (vitest + jsdom) covering authentication, role rules, the duplicate workflow, audit trail and non-destructive statuses. |
| `docs/SCHEMA.md` | Tables and RPC catalogue. |
| `docs/DEPLOY_CLOUDFLARE.md` | Step-by-step deployment of the PWA and the database. |

## Commands

```bash
npm ci
npm run dev            # local development server
npm run typecheck      # TypeScript, no emit
npm test               # UI acceptance tests (offline backend)
npm run test:db        # database rule tests (embedded PostgreSQL)
npm run build:app      # production build + PWA service worker → dist/
npm run preview        # serve the production build locally
```

`nmbr-cloudflare-pages.zip` is the upload bundle for Cloudflare Pages; its contents are the files in
`dist/`, with `index.html` at the root.

## Demonstration accounts

| Role | Email | Password |
| --- | --- | --- |
| System Administrator | `admin@nabua.gov.ph` | `Admin@NMBR2026` |
| Administrator | `maria.santos@nabua.gov.ph` | `Admin@NMBR2026` |
| Encoder | `pedro.reyes@nabua.gov.ph` | `Encoder@2026` |
| Viewer (read-only) | `viewer@nabua.gov.ph` | `Viewer@2026` |

These are fictional accounts with fictional data. Change them before the system carries real
resident information.

## How duplicate prevention works

1. **Search before add** — creating a member always starts with a search of the whole municipality.
2. **Live check** — while the form is being filled the registry is re-checked (debounced), and the
   Save control stays disabled until the verdict arrives.
3. **Explained matches** — every candidate is scored on name, middle name, birthdate, sex, barangay,
   purok, address and contact number, with a per-field explanation of why it matched.
4. **Bands** — 95–100 % blocks the save, 80–94 % requires explicit confirmation, 60–79 % is
   informational, below 60 % is treated as a new person. Thresholds and weights are configurable in
   Settings by a System Administrator.
5. **Database guard** — a normalised identity key is unique on the persons table, so two encoders
   submitting the same resident at the same moment cannot both succeed. The second attempt is
   refused and the pair is queued for review.
6. **Human decisions** — duplicate cases are resolved in the Duplicate Review Center (merge, mark as
   different people, keep both, investigate later). Merging archives the losing record with a pointer
   to the survivor; nothing is ever hard-deleted.

## Setting up the central database

The app works on a single device straight away, and tells you when the central
database has not been created yet. To switch it on:

1. Sync Centre (or Settings → Municipal server) → **Download setup SQL**.
2. Supabase → SQL Editor → paste the file → **Run**.
3. Back in the app → **Check the server again**. Queued work uploads automatically.

The file is assembled from `supabase/migrations/` during the build, so it cannot
drift from the schema the application is tested against. Full details, including
creating staff accounts, are in `docs/DEPLOY_CLOUDFLARE.md`.

## Offline behaviour

The application is an installable PWA. Reads are served from the municipal server when reachable and
from the on-device registry copy otherwise; writes fall back to the local copy and are queued in the
Sync Centre, then replayed automatically. A queued change that the server rejects (for example a
duplicate created meanwhile) is parked as a conflict for a human decision — it is never discarded
silently.
