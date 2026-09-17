import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
const db = new PGlite()
await db.exec(`do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;`)
await db.exec(readFileSync('public/setup/NMBR-supabase-setup.sql', 'utf8'))
await db.exec(readFileSync('public/setup/NMBR-demonstration-data.sql', 'utf8'))
const r = await db.query(`
  select
    (select count(*) from persons) as persons,
    (select count(*) from audit_logs) as audit_rows,
    (select pg_total_relation_size('persons')) as persons_total,
    (select pg_relation_size('persons')) as persons_heap,
    (select pg_indexes_size('persons')) as persons_idx,
    (select pg_total_relation_size('audit_logs')) as audit_total,
    (select pg_total_relation_size('member_barangay_history')) as mbh_total,
    (select pg_database_size(current_database())) as db_all`)
const row = r.rows[0]
const per = (b) => Math.round(Number(b) / Number(row.persons))
console.log(JSON.stringify({ ...row, per_person_heap: per(row.persons_heap), per_person_idx: per(row.persons_idx), per_person_total: per(row.persons_total), audit_per_person: Math.round(Number(row.audit_total) / Number(row.audit_rows)) }, null, 1))
const s40 = (bytes, n) => `${(Number(bytes) / Number(row.persons) * n / 1048576).toFixed(1)} MB`
console.log('40k persons table+indexes:', s40(row.persons_total, 40000))
console.log('40k audit (1 row per encode):', s40(row.audit_total, 40000))
