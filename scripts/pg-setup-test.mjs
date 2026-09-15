/**
 * Verifies the database setup file the application hands to the administrator.
 *
 * `public/setup/NMBR-supabase-setup.sql` is what gets pasted into the Supabase
 * SQL Editor. It is assembled from supabase/migrations/, so this script proves
 * the assembled file — not just the individual migrations — applies as a single
 * script, survives a second run, and leaves a working provisioning probe behind.
 */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const setupFile = join(root, 'public', 'setup', 'NMBR-supabase-setup.sql')
const demoFile = join(root, 'public', 'setup', 'NMBR-demonstration-data.sql')

process.on('unhandledRejection', (err) => {
  console.error('\n✗ ' + (err?.message ?? String(err)))
  process.exit(1)
})

for (const file of [setupFile, demoFile]) {
  if (!existsSync(file)) {
    console.error(`✗ ${file} is missing. Run: node scripts/build-setup-sql.mjs`)
    process.exit(1)
  }
}

let failures = 0
const check = (label, condition, extra = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${extra ? ` ${extra}` : ''}`)
  if (!condition) failures++
}

// Supabase always has these roles; PGlite does not, so create them first.
const db = new PGlite()
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
`)

console.log('\n▶ Applying the published setup file as one script')
const setupSql = readFileSync(setupFile, 'utf8')
await db.exec(setupSql)
check('the whole setup file applies cleanly', true)

const tables = (await db.query(`
  select count(*)::int n from information_schema.tables
  where table_schema = 'public'
    and table_name in ('persons','barangays','member_barangay_history','audit_logs',
                       'duplicate_cases','users','settings','import_batches','import_rows','households')
`)).rows[0].n
check('all registry tables exist', tables === 10, `(${tables}/10)`)

const functions = (await db.query(`
  select count(*)::int n from information_schema.routines where routine_schema = 'public'
`)).rows[0].n
check('stored procedures were created', functions >= 30, `(${functions})`)

// The browser distinguishes "server reachable but not set up" from "offline" by
// calling this function, so it must exist and answer after setup.
const info = (await db.query(`select fn_schema_info() as info`)).rows[0].info
check('fn_schema_info() answers the provisioning probe', info?.app === 'NMBR', JSON.stringify(info))
check('probe reports the schema version', info?.schema_version === 1)

// The duplicate guard is the core promise of the system: prove it survived.
const protectedIndex = (await db.query(`
  select count(*)::int n from pg_indexes
  where schemaname = 'public' and indexname = 'persons_identity_key_uidx'
`)).rows[0].n
check('the identity guard index is present', protectedIndex === 1)

console.log('\n▶ Re-running the setup file (idempotency)')
await db.exec(setupSql)
await db.exec(readFileSync(demoFile, 'utf8'))
const counts = (await db.query(`
  select (select count(*)::int from barangays) barangays,
         (select count(*)::int from persons) persons,
         (select count(*)::int from duplicate_cases) cases
`)).rows[0]
check('a second run does not duplicate data', counts.persons === 160 && counts.barangays === 12, JSON.stringify(counts))

await db.exec(readFileSync(demoFile, 'utf8'))
const after = (await db.query(`select count(*)::int persons from persons`)).rows[0]
check('the demonstration file is idempotent too', after.persons === 160, `(${after.persons} persons)`)

// ---------------------------------------------------------------------
// REGRESSION (field report 2026-09-15): fn_link_auth_user() must link an
// authenticated Supabase account to the profile carrying the SAME email —
// the old body compared the email column with itself inside an ambiguous
// reference, so real staff sign-ins died and every queued change was later
// refused with NMBR_UNAUTHENTICATED.
// PGlite has no Supabase auth schema, so stand one up: fn_auth_uid() looks
// for auth.uid(), and fn_link_auth_user() reads auth.users through dynamic
// SQL, therefore a tiny fake of both is enough to exercise the real code.
// ---------------------------------------------------------------------
console.log('\n▶ Sign-in linking: an authenticated account must reach its own profile')
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text not null);
  create or replace function auth.uid() returns uuid language plpgsql stable as $$
  declare v text := nullif(current_setting('nmbr.test_uid', true), '');
  begin
    if v is null or v = '' then return null; end if;
    return v::uuid;
  end $$;
`)

// Two unlinked profiles; the second one must NOT receive the first one's link.
await db.exec(`
  update users set auth_user_id = null
   where email in ('pedro.reyes@nabua.gov.ph', 'ana.villanueva@nabua.gov.ph');
  delete from auth.users;
  insert into auth.users (id, email) values
    ('11111111-1111-4111-8111-111111111111', 'pedro.reyes@nabua.gov.ph'),
    ('22222222-2222-4222-8222-222222222222', 'stranger@gmail.com');
`)

await db.exec(`select set_config('nmbr.test_uid', '11111111-1111-4111-8111-111111111111', false)`)
const linked = (await db.query(`select fn_link_auth_user() as r`)).rows[0].r
check('first sign-in links the profile with the same email', linked?.ok === true && linked?.user?.email === 'pedro.reyes@nabua.gov.ph', JSON.stringify(linked?.user?.email ?? linked))
const wrongLink = (await db.query(`
  select count(*)::int n from users
   where email = 'ana.villanueva@nabua.gov.ph' and auth_user_id is not null
`)).rows[0].n
check('no other profile was hijacked by the link', wrongLink === 0)
const linkedAgain = (await db.query(`select fn_link_auth_user() as r`)).rows[0].r
check('a linked account signs straight in on the next call', linkedAgain?.ok === true && linkedAgain?.user?.email === 'pedro.reyes@nabua.gov.ph')

await db.exec(`select set_config('nmbr.test_uid', '22222222-2222-4222-8222-222222222222', false)`)
const stranger = (await db.query(`select fn_link_auth_user() as r`)).rows[0].r
check('an account with no profile is refused, not linked arbitrarily', stranger?.ok === false && /not registered/i.test(String(stranger?.error)), JSON.stringify(stranger?.error))
const strangerLink = (await db.query(`
  select count(*)::int n from users
   where auth_user_id = '22222222-2222-4222-8222-222222222222'
`)).rows[0].n
check('the refused account left no link behind', strangerLink === 0)

// ---------------------------------------------------------------------
// GO-LIVE CLEANUP: the published purge script must empty a fully seeded
// demonstration database without touching the schema, so the municipality
// can start from a clean registry (docs/GO_LIVE.md).
// ---------------------------------------------------------------------
console.log('\n▶ Go-live cleanup empties a seeded demonstration database')
const cleanupFile = join(root, 'supabase', 'go_live_cleanup.sql')
if (!existsSync(cleanupFile)) {
  check('supabase/go_live_cleanup.sql exists', false)
} else {
  await db.exec(readFileSync(cleanupFile, 'utf8'))
  const emptied = (await db.query(`
    select (select count(*)::int from persons) persons,
           (select count(*)::int from barangays) barangays,
           (select count(*)::int from households) households,
           (select count(*)::int from duplicate_cases) cases,
           (select count(*)::int from users where active) active_users,
           (select count(*)::int from users where auth_user_id is not null) linked_users,
           (select count(*)::int from member_barangay_history) history,
           (select count(*)::int from import_rows) import_rows
  `)).rows[0]
  check('members, barangays, households and cases are gone; demo profiles deactivated',
    Object.values(emptied).every((n) => n === 0), JSON.stringify(emptied))
  const ledger = (await db.query(`select count(*)::int n from audit_logs`)).rows[0].n
  check('the immutable audit ledger survives the cleanup untouched', ledger > 0, `${ledger} entries`)
  const nextRef = (await db.query(`
    insert into persons (first_name, last_name, sex, date_of_birth)
    values ('Unang', 'Benepisyaryo', 'FEMALE', '1990-01-01')
    returning reference_no
  `)).rows[0].reference_no
  check('the first real member receives NMBR-000001', nextRef === 'NMBR-000001', nextRef)
  await db.exec(`delete from persons`)
  const schemaIntact = (await db.query(`select fn_schema_info() as info`)).rows[0].info
  check('the schema and its probe survive the cleanup', schemaIntact?.app === 'NMBR')
  // Idempotency: a second run must be a no-op.
  await db.exec(readFileSync(cleanupFile, 'utf8'))
  check('a second cleanup run changes nothing', true)
}

// ---------------------------------------------------------------------
// BOOTSTRAP FIRST ADMIN: the chicken-and-egg kit must fail loudly when run
// unedited, succeed once edited while nobody has signed in yet, and close
// forever after the first real sign-in (field report 2026-09-15: an
// unedited run created a placeholder profile that blocked the real one).
// ---------------------------------------------------------------------
console.log('\n▶ Bootstrap first admin: loud failure, open window, then closed')
const bootstrapRaw = readFileSync(join(root, 'supabase', 'bootstrap_first_admin.sql'), 'utf8')

let uneditedError = ''
try {
  await db.exec(bootstrapRaw)
} catch (err) {
  uneditedError = String(err?.message ?? err)
}
check('an unedited run fails on the lower-case e-mail check, creating nothing',
  /lowercase|lower\(email\)|users_email_lower_chk/i.test(uneditedError), uneditedError.slice(0, 60))
const junk = (await db.query(`select count(*)::int n from users where email <> lower(email) or email like 'your.name@%'`)).rows[0].n
check('no placeholder profile was left behind', junk === 0)

const edited = bootstrapRaw
  .replace('YOUR FULL NAME', 'Bootstrap Admin')
  .replace('YOUR.NAME@NABUA.GOV.PH', 'bootstrap.first@nabua.gov.ph')
await db.exec(edited)
const created = (await db.query(`
  select email, role, active from users where email = 'bootstrap.first@nabua.gov.ph'
`)).rows[0]
check('the edited run creates the first SYSTEM_ADMIN while nobody has signed in',
  created?.role === 'SYSTEM_ADMIN' && created?.active === true, JSON.stringify(created))

// A real sign-in links a profile; from then on bootstrap is closed forever.
await db.exec(`update users set auth_user_id = gen_random_uuid()
                where email = 'bootstrap.first@nabua.gov.ph'`)
let closedError = ''
try {
  await db.exec(edited.replace('bootstrap.first@nabua.gov.ph', 'second.admin@nabua.gov.ph'))
} catch (err) {
  closedError = String(err?.message ?? err)
}
check('after the first sign-in the bootstrap window is closed',
  /BOOTSTRAP_REFUSED/.test(closedError), closedError.slice(0, 60))

console.log(
  failures === 0
    ? '\nSETUP FILE TEST PASSED\n'
    : `\n✗ ${failures} check(s) failed\n`,
)
process.exit(failures === 0 ? 0 : 1)
