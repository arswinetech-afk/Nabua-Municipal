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

console.log(
  failures === 0
    ? '\nSETUP FILE TEST PASSED\n'
    : `\n✗ ${failures} check(s) failed\n`,
)
process.exit(failures === 0 ? 0 : 1)
