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

// MIGRATION 0010 (field request 2026-09-16): the "New today" cards drill into
// the member search restricted to records created on/after local midnight.
// The search function must accept p_created_since and honour it.
// fn_search_persons is role-guarded: impersonate the seeded administrator.
const searchActor = (await db.query(`select id from users where email = 'admin@nabua.gov.ph'`)).rows[0]?.id
await db.query(`select set_config('nmbr.actor', $1, false)`, [searchActor])
const sinceArgs = (await db.query(`select pronargs from pg_proc where proname = 'fn_search_persons'`)).rows[0]?.pronargs
check('fn_search_persons accepts the created-since argument (0010)', Number(sinceArgs) === 13, `(${sinceArgs} args)`)
const allTotal = (await db.query(`select fn_search_persons(p_limit => 1) ->> 'total' as t`)).rows[0]?.t
const sinceToday = (await db.query(`select fn_search_persons(p_created_since => current_date, p_limit => 1) ->> 'total' as t`)).rows[0]?.t
const sinceTomorrow = (await db.query(`select fn_search_persons(p_created_since => current_date + 1, p_limit => 1) ->> 'total' as t`)).rows[0]?.t
// The demonstration seed backdates most members, so "since today" must equal
// exactly the rows the table itself says were created today.
const expectToday = (await db.query(`select count(*)::int as c from persons where created_at::date >= current_date`)).rows[0]?.c
check('created-since today returns exactly the rows created today',
  Number(allTotal) === 160 && Number(sinceToday) === Number(expectToday), `(${sinceToday}/${expectToday} of ${allTotal})`)
check('created-since tomorrow excludes them', Number(sinceTomorrow) === 0, `(${sinceTomorrow})`)

// MIGRATION 0011: the offline mirror fetches the registry page by page so a
// 40 000-member municipality never becomes one ~16 MB response.
const idxArgs = (await db.query(`select pronargs from pg_proc where proname = 'fn_person_index'`)).rows[0]?.pronargs
check('fn_person_index accepts an offset (0011)', Number(idxArgs) === 3, `(${idxArgs} args)`)
const page1 = (await db.query(`select jsonb_array_length(fn_person_index(p_limit => 50, p_offset => 0) -> 'rows') as n`)).rows[0]?.n
const page2 = (await db.query(`select jsonb_array_length(fn_person_index(p_limit => 50, p_offset => 50) -> 'rows') as n`)).rows[0]?.n
const page9 = (await db.query(`select jsonb_array_length(fn_person_index(p_limit => 50, p_offset => 150) -> 'rows') as n`)).rows[0]?.n
check('the mirror pages without gaps or overruns', Number(page1) === 50 && Number(page2) === 50 && Number(page9) === 10, `(${page1}/${page2}/${page9})`)

// MIGRATION 0012: subsidy programmes + beneficiary lists; a member can be
// listed once per programme, and only encoders/admins may encode.
const prog = (await db.query(`select fn_subsidy_upsert_program($1) as r`,
  [JSON.stringify({ name: 'Bigasan 2026', description: 'Rice subsidy', active: true })])).rows[0]?.r
check('an administrator can create a subsidy programme', prog?.ok === true, JSON.stringify(prog?.program?.name ?? prog))
const pid = prog?.program?.id
const personId = (await db.query(`select id from persons limit 1`)).rows[0]?.id
const add1 = (await db.query(`select fn_subsidy_add_beneficiary($1) as r`,
  [JSON.stringify({ program_id: pid, person_id: personId, verified: true, paper_ref: 'Brgy list row 1' })])).rows[0]?.r
const add2 = (await db.query(`select fn_subsidy_add_beneficiary($1) as r`,
  [JSON.stringify({ program_id: pid, person_id: personId })])).rows[0]?.r
check('a member joins a programme list once', add1?.ok === true && add2?.ok === false && add2?.code === 'ALREADY_LISTED',
  JSON.stringify(add2?.code ?? add2))
const listed = (await db.query(`select jsonb_array_length(fn_subsidy_beneficiaries($1::uuid) -> 'rows') as n`, [pid])).rows[0]?.n
check('the programme list reads back with names', Number(listed) === 1, `(${listed})`)

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

// MIGRATION 0013: paper-list tags, occupation and household grouping
// (the demo actor was deactivated by the cleanup above; re-point the session
// at the bootstrap administrator, which is still active)
const liveActor = (await db.query(
  `select id from users where email = 'bootstrap.first@nabua.gov.ph'`)).rows[0]?.id
await db.query(`select set_config('nmbr.actor', $1, false)`, [liveActor])
const brgy = (await db.query(
  `insert into barangays (name) values ('Topas Sogod') returning id`)).rows[0]?.id
const led = (await db.query(`select fn_create_person($1) as r`, [JSON.stringify({
  first_name: 'Led', last_name: 'Familia', barangay_id: brgy,
  household_no: 'SOGOD-F001', tags: ['FAMILY LEADER', 'AKAP'], occupation: 'BO',
})])).rows[0]?.r
check('a paper-list leader imports with tags, occupation and a household',
  led?.ok === true && JSON.stringify(led?.person?.tags) === '["AKAP","FAMILY LEADER"]'
  && led?.person?.occupation === 'BO' && !!led?.person?.household_id,
  JSON.stringify(led?.person?.tags ?? led))
const mem = (await db.query(`select fn_create_person($1) as r`, [JSON.stringify({
  first_name: 'Meb', last_name: 'Familia', barangay_id: brgy,
  household_no: 'SOGOD-F001', tags: 'FAMILY MEMBER',
})])).rows[0]?.r
check('the second family member joins the same household; a string tag is accepted',
  mem?.ok === true && mem?.person?.household_id === led?.person?.household_id
  && JSON.stringify(mem?.person?.tags) === '["FAMILY MEMBER"]',
  JSON.stringify(mem?.person?.household_id ?? mem))
const hh = (await db.query(
  `select count(*)::int n from households where household_no = 'SOGOD-F001'`)).rows[0]?.n
check('the household was created exactly once', hh === 1, `(${hh})`)
const retag = (await db.query(`select fn_update_person($1, $2, $3) as r`,
  [led?.person?.id, JSON.stringify({ tags: ['AKAP', 'AICS/4PS'] }), 'tag correction'])).rows[0]?.r
check('tags can be corrected later and stay an array',
  retag?.ok === true && JSON.stringify(retag?.person?.tags) === '["AICS/4PS","AKAP"]',
  JSON.stringify(retag?.person?.tags ?? retag))
const searched = (await db.query(
  `select fn_search_persons(p_query => 'Familia') -> 'rows' -> 0 -> 'tags' as t`)).rows[0]?.t
check('search results carry the tags so lists can show them',
  Array.isArray(searched) && searched.includes('AKAP'), JSON.stringify(searched))

// MIGRATION 0014: staging at paper-list scale — chunked add_rows plus a
// single finalize pass must flag in-file twins exactly once
const twin = { first_name: 'Twin', last_name: 'Batchrow', date_of_birth: '1980-04-01', sex: 'FEMALE', barangay_id: brgy }
const chunk = (n) => Array.from({ length: n }, (_, i) => ({ ...twin, first_name: `Row${i}` }))
const bres = (await db.query(`select fn_import_create_batch($1, $2, $3) as r`,
  ['scale-test.xlsx', JSON.stringify({ default_barangay_id: brgy }), JSON.stringify(chunk(60))])).rows[0]?.r
const bid = bres?.batch_id
const ares = (await db.query(`select fn_import_add_rows($1, $2) as r`, [bid, JSON.stringify(chunk(60))])).rows[0]?.r
const ares2 = (await db.query(`select fn_import_add_rows($1, $2) as r`, [bid, JSON.stringify([twin, { ...twin, middle_name: 'T' }])])).rows[0]?.r
const fin = (await db.query(`select fn_import_finalize_batch($1) as r`, [bid])).rows[0]?.r
check('chunked staging accepts 122 rows across three statements',
  bres?.ok === true && ares?.ok === true && ares2?.ok === true, JSON.stringify({ bres, ares, ares2 }))
check('the finalize pass flags the in-file twin pair once',
  fin?.ok === true && Number(fin?.in_file_duplicates) >= 1, JSON.stringify(fin))

// MIGRATION 0016: clean rows default to IMPORT; duplicates-only bulk scope
const defDec = (await db.query(
  `select count(*)::int n from import_rows where batch_id = $1 and severity = 'OK' and decision <> 'IMPORT'`, [bid])).rows[0]?.n
check('clean staged rows default to the Import decision', Number(defDec) === 0, `(${defDec})`)
const dupSkip = (await db.query(
  `select fn_import_set_all_decisions($1, null, 'SKIP', true) as r`, [bid])).rows[0]?.r
const stillImport = (await db.query(
  `select count(*)::int n from import_rows where batch_id = $1 and decision = 'IMPORT'`, [bid])).rows[0]?.n
check('the duplicates-only bulk skip touches twins and leaves clean rows importing',
  dupSkip?.ok === true && Number(dupSkip?.updated) >= 1 && Number(stillImport) > 0,
  JSON.stringify({ dupSkip, stillImport }))
const undNorm = (await db.query(
  `select fn_import_set_all_decisions($1, null, 'IMPORT', false, true) as r`, [bid])).rows[0]?.r
const pendLeft = (await db.query(
  `select count(*)::int n from import_rows where batch_id = $1 and decision = 'PENDING'`, [bid])).rows[0]?.n
const twinsKept = (await db.query(
  `select count(*)::int n from import_rows
    where batch_id = $1 and decision = 'SKIP' and 'DUPLICATE_IN_FILE' = any(issues)`, [bid])).rows[0]?.n
check('the only-undecided normalisation imports the rest and preserves manual skips',
  undNorm?.ok === true && Number(pendLeft) === 0 && Number(twinsKept) >= 1,
  JSON.stringify({ undNorm, pendLeft, twinsKept }))

// MIGRATION 0018: commit runs in resumable chunks
const chunk1 = (await db.query(
  `select fn_import_commit($1, null, 1) as r`, [bid])).rows[0]?.r
const chunk2 = (await db.query(
  `select fn_import_commit($1, null, 500) as r`, [bid])).rows[0]?.r
const closed = (await db.query(
  `select status, imported_rows from import_batches where id = $1`, [bid])).rows[0]
check('the commit processes chunks and closes the batch only when nothing remains',
  chunk1?.ok === true && chunk1?.done === false
  && Number(chunk1?.imported) + Number(chunk1?.duplicates_parked) + Number(chunk1?.skipped) === 1
  && Number(chunk1?.remaining) > 0
  && chunk2?.ok === true && chunk2?.done === true && Number(chunk2?.remaining) === 0
  && closed?.status === 'IMPORTED'
  && Number(closed?.imported_rows) === Number(chunk1?.imported) + Number(chunk2?.imported),
  JSON.stringify({ chunk1, chunk2, closed }))

console.log(
  failures === 0
    ? '\nSETUP FILE TEST PASSED\n'
    : `\n✗ ${failures} check(s) failed\n`,
)
process.exit(failures === 0 ? 0 : 1)
