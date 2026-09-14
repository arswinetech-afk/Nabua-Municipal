/** Verifies that supabase/seed.sql loads cleanly on top of the migrations and
 *  that the demo duplicate pairs are still detectable afterwards. */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(root, 'supabase', 'migrations')

process.on('unhandledRejection', (err) => {
  console.error('\n✗ ' + (err?.message ?? String(err)))
  process.exit(1)
})

const db = new PGlite()
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
`)
for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(migrationsDir, f), 'utf8'))
}
await db.exec(readFileSync(join(root, 'supabase', 'seed.sql'), 'utf8'))
console.log('✓ migrations + seed.sql applied')

const counts = (await db.query(`
  select (select count(*)::int from barangays) barangays,
         (select count(*)::int from persons) persons,
         (select count(*)::int from persons where status <> 'ARCHIVED') live,
         (select count(*)::int from duplicate_cases) cases,
         (select count(*)::int from duplicate_cases where status = 'PENDING') pending,
         (select count(*)::int from member_barangay_history) history,
         (select count(*)::int from users) users
`)).rows[0]
console.log('  counts:', counts)

// Re-run safety
await db.exec(readFileSync(join(root, 'supabase', 'seed.sql'), 'utf8'))
const after = (await db.query(`select count(*)::int persons, (select count(*)::int from duplicate_cases) cases from persons`)).rows[0]
const idempotent = after.persons === counts.persons && after.cases === counts.cases
console.log(idempotent ? '✓ re-running the seed is idempotent' : `✗ re-run duplicated rows: ${JSON.stringify(after)}`)

// The demo duplicate pairs must still be flagged by the engine
const sample = (await db.query(`select normalized from import_rows limit 1`).catch(() => ({ rows: [] }))).rows
const pairs = (await db.query(`
  select d.match_score, d.status, a.reference_no a_ref, b.reference_no b_ref,
         fn_score_pair(fn_person_index_json(b) || jsonb_build_object('barangay_name', fn_person_barangay_name(b)), a) as live_score
  from duplicate_cases d
  join persons a on a.id = d.person_id_a
  join persons b on b.id = d.person_id_b
  where d.status = 'PENDING'
  order by d.match_score desc
  limit 11
`)).rows
console.log('\n  pending cases with live re-scoring:')
for (const p of pairs) {
  console.log(`   • ${p.status} stored=${Number(p.match_score).toFixed(0)}% live=${Number(p.live_score.score).toFixed(0)}% (${p.live_score.band}) ${p.a_ref} / ${p.b_ref}`)
}

const adminId = (await db.query(`select id from users where email = 'admin@nabua.gov.ph'`)).rows[0].id
await db.exec('begin')
await db.query(`select set_config('nmbr.actor', $1, true)`, [adminId])
const dataQuality = (await db.query(`select fn_data_quality() as r`)).rows[0].r
const dash = (await db.query(`select fn_dashboard_stats() as r`)).rows[0].r
await db.exec('commit')
console.log('\n  dashboard:', JSON.stringify(dash))
const byId = Object.fromEntries(dataQuality.map((m) => [m.id, m.count]))
console.log('\n  data quality snapshot:', JSON.stringify(byId))
console.log('\n' + (idempotent ? 'SEED TEST PASSED' : 'SEED TEST FAILED'))
process.exit(idempotent ? 0 : 1)
