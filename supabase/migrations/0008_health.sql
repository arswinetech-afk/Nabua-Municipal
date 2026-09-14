-- =====================================================================
-- 0008 — HEALTH / PROVISIONING CHECK
--
-- The browser must be able to tell three different situations apart:
--
--   1. the office has no connection to Supabase        → keep working offline
--   2. Supabase answers but the NMBR schema is missing → the database has not
--      been set up yet (the migrations were never run)
--   3. everything is deployed                          → use the server
--
-- Without this distinction a freshly installed copy reports failed uploads that
-- are really just a missing database, which looks like a bug to the encoder.
-- fn_schema_info() is the cheapest possible call that only exists once the NMBR
-- schema is in place, so calling it is an exact provisioning test.
-- =====================================================================

create or replace function fn_schema_info()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'app',             'NMBR',
    'schema_version',  1,
    'checked_at',      now(),
    'barangays',       (select count(*) from barangays),
    'persons',         (select count(*) from persons where merged_into is null),
    'pending_duplicates', (select count(*) from duplicate_cases where status = 'PENDING')
  );
$$;

comment on function fn_schema_info() is
  'Provisioning probe for the NMBR browser client: exists only when the schema has been deployed.';

-- Grant only to signed-in municipal staff; the row counts are not public.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function fn_schema_info() to authenticated';
  end if;
end $$;
