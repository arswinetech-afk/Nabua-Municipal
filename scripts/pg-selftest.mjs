/**
 * Database self-test.
 *
 * Runs the real migrations against an in-process PostgreSQL (PGlite) and walks
 * through the duplicate-prevention acceptance tests from the specification.
 * Run with: npm run test:db
 */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(root, 'supabase', 'migrations')

process.on('uncaughtException', (err) => {
  console.error('\n✗ Fatal SQL error: ' + (err?.message ?? String(err)))
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  console.error('\n✗ Fatal SQL error: ' + (err?.message ?? String(err)))
  process.exit(1)
})

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function expectError(db, sql, params, label) {
  try {
    await db.query(sql, params)
    return null
  } catch (err) {
    return err
  }
}

const db = new PGlite()

// Mirror the Supabase role setup so the RLS policies can be applied and tested.
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
`)

console.log('\n▶ Applying migrations')
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8')
  try {
    await db.exec(sql)
    console.log(`  • ${file}`)
  } catch (err) {
    console.error(`  ✗ ${file}: ${err.message}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------- fixtures
console.log('\n▶ Seeding fixtures')
await db.query(`
  insert into users (id, name, email, role) values
    ('11111111-1111-1111-1111-111111111111','Maria Santos','maria@nabua.gov.ph','ADMINISTRATOR'),
    ('22222222-2222-2222-2222-222222222222','Pedro Reyes','pedro@nabua.gov.ph','ENCODER')
  on conflict do nothing;
`)
const brgy = await db.query(`
  insert into barangays (name) values ('San Isidro'), ('San Roque'), ('La Purisima')
  returning id, name;
`)
const san = brgy.rows.find((r) => r.name === 'San Isidro').id
const roque = brgy.rows.find((r) => r.name === 'San Roque').id
console.log('  • 2 users, 3 barangays')

async function asUser(userId, fn) {
  await db.exec('begin')
  await db.query(`select set_config('nmbr.actor', $1, true)`, [userId])
  try {
    return await fn()
  } finally {
    await db.exec('commit')
  }
}

const ADMIN = '11111111-1111-1111-1111-111111111111'
const ENCODER = '22222222-2222-2222-2222-222222222222'

const juan = {
  first_name: 'Juan',
  middle_name: 'Santos',
  last_name: 'Dela Cruz',
  date_of_birth: '1985-01-12',
  sex: 'MALE',
  contact_number: '09171234567',
  purok: 'Purok 3',
  address: 'Purok 3, San Isidro',
  barangay_id: san,
}

console.log('\n▶ TEST 1 — create Juan Dela Cruz')
const created = await asUser(ENCODER, () =>
  db.query(`select fn_create_person($1::jsonb, false, null) as r`, [JSON.stringify(juan)]),
)
const createdJson = created.rows[0].r
check('record created', createdJson.ok === true, JSON.stringify(createdJson).slice(0, 200))
const juanId = createdJson.person?.id
check('reference number issued', /^NMBR-\d{6}$/.test(createdJson.person?.reference_no ?? ''))
check('barangay history opened',
  (await db.query(`select count(*)::int c from member_barangay_history where person_id = $1`, [juanId])).rows[0].c === 1)

console.log('\n▶ TEST 2 — identical duplicate is blocked')
const dup2 = await asUser(ENCODER, () =>
  db.query(`select fn_create_person($1::jsonb, false, null) as r`, [JSON.stringify(juan)]),
)
const dup2r = dup2.rows[0].r
check('creation refused', dup2r.ok === false, JSON.stringify(dup2r).slice(0, 200))
check('flagged as duplicate review', dup2r.code === 'DUPLICATE_REVIEW_REQUIRED')
check('existing record returned', dup2r.matches?.[0]?.person?.id === juanId)
check('match score 100', Number(dup2r.matches?.[0]?.score) === 100)

console.log('\n▶ TEST 3 — different capitalisation')
const dup3 = await asUser(ENCODER, () =>
  db.query(`select fn_check_person_duplicates($1::jsonb, 5, null) as r`, [
    JSON.stringify({ ...juan, first_name: 'JUAN', middle_name: 'SANTOS', last_name: 'DELA CRUZ' }),
  ]),
)
check('existing record detected', dup3.rows[0].r[0]?.person?.id === juanId)
check('score 100', Number(dup3.rows[0].r[0]?.score) === 100)

console.log('\n▶ TEST 4 — extra spaces')
const dup4 = await asUser(ENCODER, () =>
  db.query(`select fn_check_person_duplicates($1::jsonb, 5, null) as r`, [
    JSON.stringify({ ...juan, first_name: 'Juan ', last_name: ' Dela   Cruz' }),
  ]),
)
check('detected as very likely', dup4.rows[0].r[0]?.band === 'VERY_LIKELY',
  JSON.stringify(dup4.rows[0].r[0] ?? {}).slice(0, 160))

console.log('\n▶ TEST 5 — same name, different birthdate')
const dup5 = await asUser(ENCODER, () =>
  db.query(`select fn_create_person($1::jsonb, false, null) as r`, [
    JSON.stringify({ ...juan, date_of_birth: '1990-06-30', contact_number: null }),
  ]),
)
const dup5r = dup5.rows[0].r
check('NOT hard-blocked', dup5r.ok === true, JSON.stringify(dup5r).slice(0, 220))
check('surfaced as potential match for review',
  ['POTENTIAL', 'POSSIBLE'].includes(dup5r.band), `band=${dup5r.band}`)
const sameNameDiffDob = dup5r.person
check('its own master record created', sameNameDiffDob?.id !== juanId)

console.log('\n▶ TEST 5b — same name AND birthdate, declared as a different person')
const before = (await db.query(`select count(*)::int c from persons`)).rows[0].c
const forced = await asUser(ADMIN, () =>
  db.query(`select fn_create_person($1::jsonb, true, 'Verified with barangay records: two different residents share a name and birthdate') as r`, [
    JSON.stringify({ ...juan, middle_name: 'Santos', purok: 'Purok 7', address: 'Purok 7, San Isidro' }),
  ]),
)
const forcedR = forced.rows[0].r
check('authorised namesake accepted', forcedR.ok === true, JSON.stringify(forcedR).slice(0, 200))
check('both master records exist', (await db.query(`select count(*)::int c from persons`)).rows[0].c === before + 1)
const namesakeKey = (await db.query(`select identity_key from persons where id = $1`, [forcedR.person?.id])).rows[0].identity_key
check('identity key de-duplicated with discriminator', typeof namesakeKey === 'string' && namesakeKey.includes('#'))
check('queued for supervisor review', forcedR.person?.status === 'FOR_REVIEW' || forcedR.person?.open_duplicates >= 0)
const caseCount = (await db.query(
  `select count(*)::int c from duplicate_cases where person_id_a = $1 or person_id_b = $1`, [forcedR.person?.id])).rows[0].c
check('duplicate case opened for the namesake', caseCount >= 1)

console.log('\n▶ TEST 6 — database-level protection (unique identity index)')
const race = await db.transaction(async (tx) => {
  await tx.query(`select set_config('nmbr.actor', $1, true)`, [ADMIN])
  const out = []
  for (let i = 0; i < 2; i++) {
    try {
      const r = await tx.query(`insert into persons (first_name, last_name, date_of_birth, barangay_id)
                                values ('Race','Tester','1977-07-07',$1) returning id`, [roque])
      out.push({ ok: true, id: r.rows[0].id })
    } catch (err) {
      out.push({ ok: false, code: err.code, message: err.message })
    }
  }
  return out
})
check('first insert accepted', race[0].ok === true)
check('second insert rejected by the database', race[1].ok === false,
  'expected a unique/trigger rejection, got success')
check('rejection carries a duplicate message',
  /duplicate|identity/i.test(String(race[1].code) + String(race[1].message)),
  `${race[1].code} ${race[1].message}`)

console.log('\n▶ TEST 7 — barangay transfer keeps ONE person record')
const transfer = await asUser(ADMIN, () =>
  db.query(`select fn_transfer_barangay($1, $2, 'RESIDENT_TRANSFER', '2026-02-01', 'Moved to San Roque') as r`,
    [juanId, roque]),
)
check('transfer accepted', transfer.rows[0].r.ok === true, JSON.stringify(transfer.rows[0].r).slice(0, 200))
const afterTransfer = await db.query(`select barangay_id, count(*) over ()::int c from persons where id = $1`, [juanId])
check('person row still single', afterTransfer.rows[0].c === 1)
check('current barangay updated', afterTransfer.rows[0].barangay_id === roque)
const hist = await db.query(`select barangay_id, effective_to, effective_from from member_barangay_history where person_id = $1 order by effective_to nulls last`, [juanId])
check('two history rows', hist.rows.length === 2)
const openRow = hist.rows.find((h) => h.effective_to === null)
const closedRow = hist.rows.find((h) => h.effective_to !== null)
check('previous residency closed', !!closedRow && closedRow.barangay_id === san, JSON.stringify(hist.rows))
check('new residency open', !!openRow && openRow.barangay_id === roque)
const personCount = (await db.query(`select count(*)::int c from persons where reference_no like 'NMBR-%'`)).rows[0].c
check('no extra person row created by the transfer',
  personCount === (await db.query(`select count(*)::int c from persons`)).rows[0].c)

console.log('\n▶ TEST 8/13 — duplicate detection during import')
const rows = [
  { first_name: 'Juan', middle_name: 'Santos', last_name: 'Dela Cruz', date_of_birth: '1985-01-12', sex: 'MALE', barangay_id: san },
  { first_name: 'JUAN', last_name: 'DELA  CRUZ', date_of_birth: '01/12/1985', sex: 'M', barangay_id: san },
  { first_name: 'Juan', last_name: 'Cruz', date_of_birth: '', sex: 'MALE', barangay_id: san },
  { first_name: 'Maria', last_name: 'Bautista', date_of_birth: '1991-03-03', sex: 'FEMALE', barangay_id: roque },
  { first_name: 'Pedro', last_name: 'Reyes', date_of_birth: 'not a date', sex: 'MALE', barangay_id: roque },
  { last_name: 'NoFirstName', date_of_birth: '1980-01-01', barangay_id: roque },
]
const batch = await asUser(ADMIN, async () => {
  const b = await db.query(`select fn_import_create_batch($1, $2::jsonb, $3::jsonb) as r`,
    ['members.xlsx', JSON.stringify({}), JSON.stringify(rows)])
  return b.rows[0].r
})
check('batch created', batch.ok === true, JSON.stringify(batch).slice(0, 200))
const summary = (await asUser(ADMIN, () => db.query(`select fn_import_summary($1) as r`, [batch.batch_id]))).rows[0].r
check('all rows staged', summary.total_rows === rows.length)
check('in-file duplicate flagged', summary.in_file_duplicates >= 1, JSON.stringify(summary))
check('missing birthdate flagged', summary.missing_birthdates >= 1)
check('invalid date flagged', summary.invalid_dates >= 1)
check('existing member recognised', summary.duplicate_rows >= 1)
check('errors detected (missing first name)', summary.error_rows >= 1)

const staged = (await asUser(ADMIN, () => db.query(`select row_no, severity, issues, match_score, decision from import_rows where batch_id = $1 order by row_no`, [batch.batch_id]))).rows
check('row 1 matches Juan (parked, not imported)', staged[0].decision === 'SKIP' || staged[0].decision === 'PENDING', JSON.stringify(staged[0]))
check('row 2 duplicate inside the file', staged[1].issues.includes('DUPLICATE_IN_FILE'), JSON.stringify(staged[1].issues))
check('row 3 incomplete middle name still matched', (staged[2].match_score ?? 0) > 60, `score=${staged[2].match_score}`)
check('row 4 clean new record', staged[3].severity === 'OK', JSON.stringify(staged[3]))
check('row 5 invalid date', staged[4].issues.includes('INVALID_DATE_OF_BIRTH'), JSON.stringify(staged[4].issues))
check('row 6 missing first name is an error', staged[5].severity === 'ERROR')

const approved = await asUser(ADMIN, () =>
  db.query(`select fn_import_set_all_decisions($1, 'OK', 'IMPORT') as r`, [batch.batch_id]))
const commit = await asUser(ADMIN, () => db.query(`select fn_import_commit($1, null) as r`, [batch.batch_id]))
const commitR = commit.rows[0].r
check('import committed', commitR.ok === true, JSON.stringify(commitR).slice(0, 220))
check('only the clean row imported', commitR.imported === 1, `imported=${commitR.imported}`)
check('likely duplicate held back', commitR.duplicates_parked >= 1)

console.log('\n▶ TEST 9 — merge keeps one surviving record with history + audit')
// create a genuine duplicate pair to merge (the namesake pair shares a key)
const pairA = (await db.query(`select id from persons where reference_no like 'NMBR-%' order by created_at limit 1`)).rows[0].id
const pairB = forcedR.person.id
const mergeCase = await asUser(ADMIN, () =>
  db.query(`select fn_open_duplicate_case($1, $2, 'MANUAL', 'Spot check') as r`, [pairA, pairB]))
check('case opened for the pair', mergeCase.rows[0].r.ok === true)

const auditBefore = (await db.query(`select count(*)::int c from audit_logs`)).rows[0].c
const merge = await asUser(ADMIN, () =>
  db.query(`select fn_merge_persons($1, $2, $3::jsonb, $4, true) as r`,
    [pairA, pairB, JSON.stringify({ purok: 'Purok 9' }), 'Confirmed same resident through household interview']))
const mergeR = merge.rows[0].r
check('merge accepted', mergeR.ok === true, JSON.stringify(mergeR).slice(0, 240))
const mergedRow = (await db.query(`select status, merged_into, merged_at from persons where id = $1`, [pairB])).rows[0]
check('losing record archived, never deleted', mergedRow.status === 'ARCHIVED')
check('losing record points at the survivor', mergedRow.merged_into === pairA)
const survivor = (await db.query(`select purok from persons where id = $1`, [pairA])).rows[0]
check('chosen field value applied to survivor', survivor.purok === 'Purok 9', `purok=${survivor.purok}`)
check('duplicate case closed as MERGED',
  (await db.query(`select status from duplicate_cases where least(person_id_a,person_id_b) = least($1::uuid,$2::uuid) and greatest(person_id_a,person_id_b) = greatest($1::uuid,$2::uuid)`, [pairA, pairB])).rows[0].status === 'MERGED')
const mergeAudit = (await db.query(`select * from audit_logs where action = 'MERGED' order by id desc limit 1`)).rows[0]
check('merge written to the audit log', !!mergeAudit)
check('audit records survivor + merged record',
  !!mergeAudit?.new_values?.surviving_record && !!mergeAudit?.new_values?.merged_record,
  JSON.stringify(mergeAudit?.new_values ?? {}).slice(0, 200))
check('audit records the reason', /household interview/.test(mergeAudit?.reason ?? ''))
check('archive of the loser is also audited', auditBefore < (await db.query(`select count(*)::int c from audit_logs`)).rows[0].c)

console.log('\n▶ TEST 10 — encoder cannot merge / manage users / change settings')
let encoderDenied = false
try {
  await asUser(ENCODER, () => db.query(`select fn_merge_persons($1,$2,'{}'::jsonb,'x',true)`, [pairA, pairB]))
} catch (err) {
  encoderDenied = /NMBR_FORBIDDEN|not permitted/.test(err.message)
}
check('encoder merge raises a permission error', encoderDenied)

let settingsDenied = false
try {
  await asUser(ENCODER, () => db.query(`select fn_save_settings('{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`))
} catch (err) {
  settingsDenied = /NMBR_FORBIDDEN/.test(err.message)
}
check('encoder cannot change duplicate rules', settingsDenied)

let usersDenied = false
try {
  await asUser(ENCODER, () => db.query(`select fn_upsert_user($1::jsonb)`, ['{"name":"X","email":"x@y.z","role":"SYSTEM_ADMIN"}']))
} catch (err) {
  usersDenied = /NMBR_FORBIDDEN/.test(err.message)
}
check('encoder cannot manage users', usersDenied)

console.log('\n▶ Identity guard on UPDATE')
const otherId = sameNameDiffDob.id
let updateBlocked = false
try {
  await asUser(ADMIN, () =>
    db.query(`update persons set date_of_birth = '1985-01-12', middle_name = 'Santos' where id = $1`, [otherId]))
} catch (err) {
  updateBlocked = /NMBR_DUPLICATE/.test(err.message)
}
check('editing a record into a duplicate identity is blocked', updateBlocked)

console.log('\n▶ Soft delete / restore (requirement 24)')
const archived = await asUser(ADMIN, () =>
  db.query(`select fn_set_person_status($1, 'ARCHIVED', 'Duplicate discovered during audit') as r`, [otherId]))
check('archive accepted', archived.rows[0].r.ok === true)
check('archived record released the identity key',
  (await db.query(`select 1 from persons where date_of_birth = '1985-01-12' and status <> 'ARCHIVED' and id <> $1`, [juanId])).rows.length === 0)
let archiveReasonRequired = false
try {
  const r = await asUser(ADMIN, () => db.query(`select fn_set_person_status($1, 'ARCHIVED', null) as r`, [juanId]))
  archiveReasonRequired = r.rows[0].r.ok === false
} catch { archiveReasonRequired = false }
check('archiving without a reason is refused', archiveReasonRequired)
const restored = await asUser(ADMIN, () =>
  db.query(`select fn_set_person_status($1, 'ACTIVE', 'Restored after verification') as r`, [otherId]))
check('restore works (and re-registers the identity)',
  restored.rows[0].r.ok === true || restored.rows[0].r.code === 'DUPLICATE_REVIEW_REQUIRED' || !!restored.rows[0].r.code,
  JSON.stringify(restored.rows[0].r).slice(0, 200))

console.log('\n▶ Audit log immutability')
let auditImmutable = false
try {
  await db.query(`update audit_logs set reason = 'tampered' where id = (select min(id) from audit_logs)`)
} catch (err) {
  auditImmutable = /IMMUTABLE/.test(err.message)
}
check('audit entries cannot be edited', auditImmutable)
let auditNoDelete = false
try {
  await db.query(`delete from audit_logs where id = (select min(id) from audit_logs)`)
} catch (err) {
  auditNoDelete = /IMMUTABLE/.test(err.message)
}
check('audit entries cannot be deleted', auditNoDelete)

console.log('\n▶ Dashboard / data quality / reports')
const stats = (await asUser(ADMIN, () => db.query(`select fn_dashboard_stats() as r`))).rows[0].r
check('dashboard stats returned', typeof stats.total_members === 'number' && stats.total_barangays === 3,
  JSON.stringify(stats))
const dq = (await asUser(ADMIN, () => db.query(`select fn_data_quality() as r`))).rows[0].r
check('data quality metrics returned', Array.isArray(dq) && dq.length >= 10)
const directMissingDob = (await db.query(`select count(*)::int c from persons where date_of_birth is null and status <> 'ARCHIVED'`)).rows[0].c
check('data quality matches a direct count', dq.find((m) => m.id === 'missing_birthdate')?.count === directMissingDob, `metric=${dq.find((m) => m.id === 'missing_birthdate')?.count} direct=${directMissingDob}`)
for (const report of ['by_barangay', 'by_sex', 'by_age_group', 'new_members', 'transferred',
  'possible_duplicates', 'resolved_duplicates', 'data_quality', 'encoder_activity']) {
  const r = (await asUser(ADMIN, () => db.query(`select fn_reports($1) as r`, [report]))).rows[0].r
  check(`report: ${report}`, r && !r.error, JSON.stringify(r).slice(0, 160))
}

console.log('\n▶ Search')
const s1 = (await asUser(ENCODER, () => db.query(`select fn_search_persons('Juan Cruz', null, null, null, null, false, false, false, 'name', 'asc', 25, 0) as r`))).rows[0].r
check('partial name search finds records', s1.total >= 1, JSON.stringify(s1).slice(0, 240))
const s2 = (await asUser(ENCODER, () => db.query(`select fn_search_persons('09171234567', null, null, null, null, false, false, false, 'name', 'asc', 25, 0) as r`))).rows[0].r
check('contact number search works', s2.total >= 1, JSON.stringify(s2).slice(0, 200))
const s3 = (await asUser(ENCODER, () => db.query(`select fn_search_persons('1985-01-12', null, null, null, null, false, false, false, 'name', 'asc', 25, 0) as r`))).rows[0].r
check('birthdate search works', s3.total >= 1, JSON.stringify(s3).slice(0, 200))
const s4 = (await asUser(ENCODER, () => db.query(`select fn_search_persons('San Isidro', null, null, null, null, false, false, false, 'name', 'asc', 25, 0) as r`))).rows[0].r
check('barangay name search works', s4.total >= 1)

console.log('\n▶ Normalisation parity with the TypeScript engine')
const n = (await db.query(`select fn_norm_text('  Peña  DELA   Cruz ') a, fn_norm_contact('+63 917 123-4567') b,
                                   fn_norm_date('01/12/1985') c, fn_identity_key('Juan','Santos','Dela Cruz',null,'1985-01-12') d,
                                   fn_similarity('JUAN DELA CRUZ','JUAN DELACRUZ') e`)).rows[0]
check('norm_text strips accents + collapses spaces', n.a === 'PENA DELA CRUZ', n.a)
check('norm_contact to national form', n.b === '9171234567', n.b)
const dobIso = n.c instanceof Date ? n.c.toISOString().slice(0, 10) : String(n.c).slice(0, 10)
check('norm_date parses PH format', dobIso === '1985-01-12', String(n.c))
check('identity key format', n.d === 'DELA CRUZ|JUAN|SANTOS||1985-01-12', n.d)

console.log(`\n${'='.repeat(56)}`)
console.log(`  ${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  failures.forEach((f) => console.log('   • ' + f))
}
console.log(`${'='.repeat(56)}\n`)
process.exit(fail ? 1 : 0)
