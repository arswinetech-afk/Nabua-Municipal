# Going live with NMBR — from demonstration to the real municipal registry

This runbook takes the system from the state it ships in (fictional barangays,
160 fictional members, printed demonstration accounts) to a published registry
that holds **real residents of Nabua** and is used daily by **real staff
accounts**. Every step is reversible until step 5, and no step deletes
anything without saying so.

It also documents the three faults found during the go-live rehearsal of
2026-09-15 and how this build fixes them — read §7 if you already deployed an
older bundle or ran the old setup SQL.

---

## 0. Prerequisites

* The app is deployed (see `docs/DEPLOY_CLOUDFLARE.md`) and the central
  database setup SQL has been run once in the Supabase project
  (Sync Centre → *Download setup SQL*, or `supabase/migrations/` in order).
* You have: (a) Supabase dashboard access, (b) the official PSA/PSGC list of
  the barangays of Nabua, (c) the roster of staff who will use the system
  (full name, official e-mail, role).

## 1. Repair the sign-in linking on the database (mandatory)

Migration `0009_fix_link_auth_user.sql` repairs `fn_link_auth_user()`, the
function that runs at every sign-in. The old version could never link a new
staff account (an ambiguous column reference made PostgreSQL refuse the
query), which is what forced devices onto the on-device registry and filled
the Sync Centre with *"Your session is not recognised"* (see §7).

Do **one** of:

* Re-run the whole current `setup/NMBR-supabase-setup.sql` from the app or
  `public/setup/` (it is idempotent and now contains 0009), **or**
* Paste only `supabase/migrations/0009_fix_link_auth_user.sql` into the
  Supabase SQL Editor and run it.

Verify afterwards (SQL Editor):

```sql
select prosrc like '%lower(email) = lower(email)%' as still_broken
  from pg_proc where proname = 'fn_link_auth_user';
-- must return: f
```

## 1b. Since-midnight drill-down (migration 0010, recommended)

The *New today* cards on the dashboard and the Barangay Directory open the
member list pre-filtered to records encoded since local midnight, so the list
matches the number on the card. That filter lives in the database
(`fn_search_persons` gained a `p_created_since` argument).

Do **one** of:

* Re-run the whole current `setup/NMBR-supabase-setup.sql` (it now contains
  0010 and remains idempotent), **or**
* Paste only `supabase/migrations/0010_search_created_since.sql` into the
  Supabase SQL Editor and run it. It drops the old 12-argument
  `fn_search_persons` by exact signature and recreates it with the new
  argument; safe to re-run.

Until 0010 is applied the cards still open the member list, simply without
the since-midnight restriction — no error is shown.

```sql
select pronargs from pg_proc where proname = 'fn_search_persons';
-- must return: 13
```

## 2. Build the production bundle without demonstration material

Production builds (`vite build`, i.e. what Cloudflare Pages serves) now ship:

* **no demonstration accounts on the sign-in page** (the panel with e-mails
  and passwords is compiled out),
* **no demonstration registry on devices** (the on-device copy starts empty;
  real records arrive through the mirror after the first online sign-in),
* **no usable demonstration passwords anywhere in the bundle** (`seed.json`
  carries salted hashes only, and they are never loaded in production).

Two flags exist for deliberate exceptions (set them in the Cloudflare Pages
project → Settings → Environment variables, then rebuild):

| Variable | Default in a production build | Set to `true` only for |
| --- | --- | --- |
| `VITE_SHOW_DEMO_ACCOUNTS` | hidden | a training bundle whose sign-in page may print the demo accounts |
| `VITE_DEMO_SEED` | off (empty on-device registry) | a training bundle that should carry the fictional registry |

Development builds (`npm run dev`, `npm test`) always keep both, so training
and testing never lose their data.

## 3. Purge the demonstration data from the central database

Run `supabase/go_live_cleanup.sql` **once**, in the Supabase SQL Editor,
**before the first real resident is encoded**. It removes, in FK-safe order:
import batches, duplicate cases, barangay history, all 160 fictional members,
demo households, and the 12 fictional barangays; it deactivates and unlinks
the demonstration profiles; and it restarts the reference counter so the
first real resident becomes `NMBR-000001`.

Notes the script itself repeats:

* Demonstration profiles are **deactivated, not deleted**: the audit ledger is
  immutable (RA 10173) and every entry points at the user who wrote it —
  deleting a user would rewrite history, which the immutability trigger
  refuses. A deactivated profile cannot sign in, cannot be linked, and stays
  listed as *inactive* — an honest record of the training period. An optional
  block at the bottom of the script shows how to delete them physically if
  the municipality accepts losing those pointers.
* The audit ledger of the training period is kept. An optional `truncate`
  (clearly marked) exists for a pristine ledger.
* The script is idempotent and refuses nothing — but it deletes **all**
  members, so never run it on a database that already holds real records.

Then create the **real barangays**, either from the Barangays page or with
the INSERT template at the bottom of the cleanup script, using the official
PSGC names exactly as published.

## 4. Create the real staff accounts

**Who can sign in at all?** Only office staff. Residents (“members”) are
*records* in the registry — they are searched, encoded, transferred and
reported on, but they never sign in; there is no resident portal in NMBR.
A staff member can sign in only when **both** halves exist and match:
a login in Supabase Authentication (e-mail + password) **and** a profile in
the `users` table (name, e-mail, role). The sign-in links the two by e-mail
automatically (migration 0009). An unregistered person who tries to sign in
is refused with *“This account is not registered in the NMBR user list. Ask
the system administrator to add you.”* — that is the guard working.

### 4a. Bootstrap the first administrator (when nobody can sign in yet)

A fresh or cleaned database has no profiles, and the demonstration logins
were never real Supabase accounts — so the very first account cannot be
created from inside the app. Create it once, outside:

1. Supabase dashboard → **Authentication → Users → Add user**: official
   e-mail, a strong temporary password, tick *Auto confirm user*.
2. SQL Editor → run `supabase/bootstrap_first_admin.sql` after editing the
   two values (name, and the same e-mail in lower case). It refuses to run
   once somebody has actually signed in (an active, linked profile). If a
   run ever goes in with the placeholder values unedited, fix that row
   (`update users set name = …, email = … where email = 'wrong…'`) or remove
   it (`delete from users where email = 'wrong…' and auth_user_id is null`)
   and run the file again — the upper-case placeholders make an unedited run
   fail loudly instead of creating a junk profile.
3. Sign in on the app with those credentials — the sign-in links login and
   profile, and you are in as `SYSTEM_ADMIN`. Change the temporary password
   afterwards in Authentication → Users.

### 4b. Everyone else — created from inside the app

For every remaining person on the roster, in this order:

1. **NMBR profile** — signed in as an administrator *while online*, open
   *Users* → *Add account*: full name, official e-mail, role
   (`SYSTEM_ADMIN` / `ADMINISTRATOR` / `ENCODER` / `VIEWER`), optional
   barangay scope. Save.
2. **Supabase login** — Supabase dashboard → Authentication → Users →
   *Add user*: the **same e-mail**, a temporary password, and send (or
   e-mail) the invitation according to office practice.
3. **First sign-in links the two**: the person signs in on the deployed app;
   the repaired `fn_link_auth_user()` matches the authenticated e-mail to the
   profile created in step 1 and links them. From then on the role, the name
   and the barangay scope come from the profile, and every audit entry carries
   them.
4. The person changes the temporary password (Supabase Authentication →
   update user, or the invitation flow).

A sign-in whose e-mail has no profile is refused with *“This account is not
registered in the NMBR user list”* — that is the guard working, not a bug:
create the profile first (step 1).

### 4c. Retiring a staff profile: deactivate, never delete

A profile that has ever done anything cannot be deleted — not from the
Supabase Table Editor, not from SQL — and that is the system protecting the
municipality:

* every audit entry keeps `user_id` → `users(id)` with `ON DELETE SET NULL`,
  and the audit log is immutable (`NMBR_AUDIT_IMMUTABLE`, P0006), so the
  foreign-key update that a delete would need is refused;
* `persons.created_by/updated_by`, `duplicate_cases`, `member_barangay_history`
  and `import_batches` point at profiles too — a delete would silently strip
  attribution from real resident records.

Supported retirement (in-app, fully audited): another `SYSTEM_ADMIN` signs in
and presses **Deactivate** on the profile (you cannot deactivate your own row
while signed in as it). The profile remains in the ledger, can no longer sign
in or be linked, and **Reactivate** brings it back if the person returns.

Exceptional physical deletion — only if the municipality accepts that audit
entries and records of that period lose their `user_id` pointer (names and
roles stay written inside each entry). The immutability trigger must be
suspended for the instant the foreign keys null their pointers:

```sql
alter table audit_logs disable trigger trg_audit_immutable;
delete from users where email = 'the.person@nabua.gov.ph';
alter table audit_logs enable trigger trg_audit_immutable;
```

Run it only while at least one other active `SYSTEM_ADMIN` remains, and write
the reason into the audit log first (`fn_log_event`) so the gap itself is
accounted for.

## 5. Reset every office device, then sign in online once

Devices that ever ran a demonstration build still carry the fictional
registry and the demo logins in their local storage. On each phone/PC:

1. Browser → site settings → **clear site data** (or uninstall the installed
   PWA), so the on-device registry rebuilds empty.
2. Open the app **with a connection** and sign in with the real account: the
   registry mirror (members, barangays, open duplicate cases) downloads and
   the device is live.

From then on, offline work keeps functioning: sessions can be re-opened
without a connection through the on-device verifier that a successful online
sign-in leaves behind (salted PBKDF2, never the password), and anything
written offline queues and uploads at the next sync.

## 6. Publish and smoke-test

After the Cloudflare Pages deployment of the production bundle:

* [ ] Sign-in page shows **no** demonstration accounts.
* [ ] A real encoder signs in online; the dashboard counts match the (empty)
      real registry, not 160.
* [ ] Add one test member with a real name; reference `NMBR-000001` appears;
      the entry is visible from a second device after sync.
* [ ] Add the same member again on another device: the duplicate engine warns
      and the database guard refuses the second master record.
* [ ] Switch the phone to airplane mode, edit a record: it queues; the Sync
      Centre shows *waiting to send*, not failures; reconnect → *sent*.
* [ ] Sign out, sign in again, and confirm the audit log shows both events
      with the real name and role.
* [ ] Archive or correct the test member through the normal workflow (never
      delete; the registry only archives/merges).

## 7. What was wrong on 2026-09-15, and what this build does about it

**Symptom 1 (Sync Centre screenshot): six queued changes — “Save user
arswinetech@gmail.com”, four “Update duplicate detection rules”, “Add member:
AR Tech” — each *failed* with “Your session is not recognised. Please sign in
again.”, after 6, 24, 31 and 46 attempts, while the header pill said
*Connected*.**

Root causes, in order:

1. `fn_link_auth_user()` (migration 0006) compared the `users.email` column
   *with itself* inside a reference that PostgreSQL treats as ambiguous
   (`email` was both a PL/pgSQL variable and a column). Every first sign-in of
   an account that was not pre-linked therefore died inside the database; the
   app fell back to the on-device registry with only a one-line toast.
2. With no server session, every write queued locally, and the sync engine
   replayed the queue against the database every 60 seconds. The guard
   triggers answered `NMBR_UNAUTHENTICATED` each time — a **state**, not a
   transient error — and each replay burned another attempt, forever.
3. The UI called that “failed” and offered *Retry*, and the header pill
   reported the *network* (fine) rather than the *session* (dead).

Fixes in this build:

* `0009_fix_link_auth_user.sql` — correct, unambiguous e-mail matching; an
  authenticated account links to exactly the profile carrying its e-mail, and
  to nothing else (proved by `scripts/pg-setup-test.mjs`, which now stands up
  a fake `auth` schema and checks both the link and the refusal paths).
* The sync engine recognises authentication refusals (`P0002` / 401 / the
  guard’s message) and **parks** the queue as *waiting for sign-in*: no
  attempts are burned, the 60-second timer stops replaying, and a successful
  server sign-in flushes everything automatically, in order.
* Writes refused for lack of session are kept on the device (like a dropped
  connection) instead of being bounced back as hard errors.
* The header pill turns rose and reads **“Sign in to sync”**, a banner appears
  on every page, and the Sync Centre explains the parked queue with a
  one-tap *Sign in to upload the queue* action (`/login?reauth=1`), which
  signs in to the server without touching the on-device session or the queue.

**Symptom 2 (sign-in screenshot): the published sign-in page printed four
demonstration accounts with their passwords.**

Fixes: the panel is compiled out of production bundles (§2); `seed.json` no
longer contains any plaintext password (salted hashes only, unused in
production); the on-device demonstration registry no longer seeds in
production builds; and `go_live_cleanup.sql` deactivates the demonstration
profiles on the server (§3).

## 8. Keeping the live system honest

* **Sudden power loss is safe for encoded work.** Every save — member
  records, edits, transfers, duplicate decisions, audit entries and queued
  changes — is written synchronously to the device's own storage
  (`localStorage`) at the moment of the save, not on a timer and not on
  close. After a reboot the records are still there; only text that was
  still sitting unsaved in an open form is lost. If the session window has
  lapsed, sign in again (offline verifier) and continue; queued changes
  upload at the next connection.
  Three caveats: never encode in private/incognito windows (storage dies
  with the window); make sure the browser is not configured to “clear
  cookies and site data when closed”; and use the same browser profile the
  registry was introduced on — a different profile is a different device as
  far as the on-device copy is concerned.
* Rotate the administrator password after the first week of live use.
* Review *Audit Logs* weekly; every add/edit/transfer/merge/import is there
  with name, role and device info.
* Keep the duplicate rules (`Settings`) under administrator control; changes
  are audited.
* Back up: Supabase dashboard → Database → Backups (daily on the paid plan;
  on the free tier schedule `pg_dump` through the provided service role).
* Never run `NMBR-demonstration-data.sql` on the live database.

## 9. Capacity: 40 000 members and the offline copy

Measured against the real schema (`scripts/pg-size-estimate.mjs`, PGlite =
real PostgreSQL storage internals, seeded demo scaled linearly):

| What | At 40 000 members |
|---|---|
| `persons` table + all indexes (incl. trigram name index) | ≈ 30–70 MB |
| `audit_logs` (one immutable row per encode/edit, with value snapshot) | ≈ 40–80 MB |
| `member_barangay_history`, cases, users | a few MB |
| **Total database** | **well under 150 MB — about a quarter of the free Supabase tier (500 MB)** |

Server-side, 40 000 is comfortably small: every list query is indexed and
paginated (`fn_search_persons` never returns the whole table), and the
duplicate guard runs per encode, not per scan.

**Offline copy.** The on-device mirror is ≈ 400 bytes per member
(≈ 16 MB at 40 000). That can never live in `localStorage` (browsers cap an
origin near 5 MB), so since migration 0011 the mirror:

* is fetched from the server **page by page** (10 000 members per
  round-trip, `fn_person_index` gained `p_offset`), so no single ~16 MB
  response stalls a weak LTE link;
* is stored in **IndexedDB**, whose quota is disk-based (hundreds of MB),
  and rehydrated on every launch — offline sign-in, search and duplicate
  checks work against it exactly as before;
* keeps only tiny things in `localStorage` (session, queue, audit, settings);
* degrades honestly: if a browser refuses the write (no IndexedDB, disk
  full), the office sees a warning toast — online work is never affected.

REGRESSION 11 proves a 400-member mirror survives a restart outside
localStorage; the PG suite proves the paging returns every row exactly once.

## 10. Subsidy (ayuda) programmes — and the line this system will not cross

Migration 0012 adds two tables — `subsidy_programs` (Bigasan, Walang Gutom,
rice/financial aid, …) and `subsidy_beneficiaries` — plus five `fn_subsidy_*`
functions with the same role gates as the rest of the registry:

| Action | Who |
|---|---|
| Read programmes and beneficiary lists | every signed-in role |
| Add a member to a programme list | ENCODER and above |
| Create/edit a programme; remove a beneficiary | ADMINISTRATOR / SYSTEM_ADMIN |

The daily flow is the paper list: the barangay hands the encoder a printed
list; the encoder opens the programme, filters by barangay, searches each
name against the registry and adds the real member record — recording
`paper_ref` (the row on the paper), whether it was `verified` against the
barangay validation, and optional notes. A member can only be listed once
per programme (`ALREADY_LISTED`), every add/remove is written to the audit
ledger with the acting officer, and removals require a reason. Members carry
a neutral `classification_code` (4Ps, senior citizen, PWD, solo parent,
indigent — barangay-validated, farmer/fisherfolk) set at encode time or on
the profile.

**The boundary.** The original request proposed tying inclusion to voting:
members tagged as having voted for the incumbent would be *automatically*
included, everyone else automatically excluded. This system deliberately
does not do that, and never will:

* **No voting or political category is stored anywhere** — not on the
  person, not on the beneficiary row. `CLASSIFICATION_CODES` contains only
  neutral, government-standard sectors.
* **No automatic eligibility engine.** Inclusion in any programme is always
  an explicit, per-row human decision by an encoder or admin, exactly like
  the paper-list cross-check the barangays already perform. The software
  records and audits the decision; it never makes it.

Why: a municipal registry that grants or withholds aid based on political
support is vote-buying infrastructure. It would expose the municipality, the
barangay officials and the operators personally (COMELEC resolution on vote
buying; DSWD/DSMB list-based assistance rules require validated,
needs-based targeting), and once such a field exists in a database it
cannot be un-leaked. The audit trail here is designed so every ayuda
decision points at a named officer and a barangay document — the opposite
of an invisible automatic rule.

Offline behaviour is unchanged from the rest of the registry: programme and
list edits apply on the device immediately and queue for upload
(`upsertSubsidyProgram`, `addSubsidyBeneficiary`, `removeSubsidyBeneficiary`
replay in the Sync Centre). REGRESSION 12 proves the dedupe, the explicit
classification override and restart durability; the PG suite proves the
server-side gates.

**Go-live step:** run migration 0012 on the production database (it is
already included in `setup/NMBR-supabase-setup.sql`). Until it is run, the
Subsidies page reports the honest "waiting for the server setup" state
instead of failing silently.
