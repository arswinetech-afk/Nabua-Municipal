-- =====================================================================
-- NMBR — 0007_security_rls.sql
-- Row Level Security, role helpers and grants.
--
-- Principles:
--  * Nothing is readable without an authenticated, active profile.
--  * The registry is WRITE-protected: all mutations go through the SECURITY
--    DEFINER RPCs, which perform their own role checks and audit every change.
--    A compromised browser can therefore not bypass authorisation.
--  * Personal data is never exposed to the anonymous role.
--
-- Policies are created through a DO block so the migration still applies on a
-- plain PostgreSQL server where the Supabase "authenticated"/"anon" roles are
-- absent (they exist in every Supabase project).
-- =====================================================================

alter table persons                 enable row level security;
alter table barangays               enable row level security;
alter table households              enable row level security;
alter table member_barangay_history enable row level security;
alter table duplicate_cases         enable row level security;
alter table audit_logs              enable row level security;
alter table users                   enable row level security;
alter table settings                enable row level security;
alter table import_batches          enable row level security;
alter table import_rows             enable row level security;

-- Actor lookup must not be filtered by RLS, otherwise policies recurse.
alter function fn_current_actor() security definer;

do $rls$
declare
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  policies jsonb := jsonb_build_array(
    jsonb_build_object('name','p_persons_select','tbl','persons','using',
      'fn_is_role(''ENCODER'',''ADMINISTRATOR'',''SYSTEM_ADMIN'',''VIEWER'')'),
    jsonb_build_object('name','p_barangays_select','tbl','barangays','using',
      'fn_is_role(''ENCODER'',''ADMINISTRATOR'',''SYSTEM_ADMIN'',''VIEWER'')'),
    jsonb_build_object('name','p_households_select','tbl','households','using',
      'fn_is_role(''ENCODER'',''ADMINISTRATOR'',''SYSTEM_ADMIN'',''VIEWER'')'),
    jsonb_build_object('name','p_mbh_select','tbl','member_barangay_history','using',
      'fn_is_role(''ENCODER'',''ADMINISTRATOR'',''SYSTEM_ADMIN'',''VIEWER'')'),
    jsonb_build_object('name','p_duplicates_select','tbl','duplicate_cases','using',
      'fn_is_role(''ENCODER'',''ADMINISTRATOR'',''SYSTEM_ADMIN'',''VIEWER'')'),
    jsonb_build_object('name','p_audit_select','tbl','audit_logs','using',
      'fn_is_role(''ADMINISTRATOR'',''SYSTEM_ADMIN'') or user_id = fn_current_user_id()'),
    jsonb_build_object('name','p_users_select','tbl','users','using',
      'id = fn_current_user_id() or auth_user_id = fn_auth_uid() or fn_is_role(''ADMINISTRATOR'',''SYSTEM_ADMIN'')'),
    jsonb_build_object('name','p_settings_select','tbl','settings','using',
      'fn_is_role(''ENCODER'',''ADMINISTRATOR'',''SYSTEM_ADMIN'',''VIEWER'')'),
    jsonb_build_object('name','p_import_batches_select','tbl','import_batches','using',
      'fn_is_role(''ADMINISTRATOR'',''SYSTEM_ADMIN'')'),
    jsonb_build_object('name','p_import_rows_select','tbl','import_rows','using',
      'fn_is_role(''ADMINISTRATOR'',''SYSTEM_ADMIN'')')
  );
  p jsonb;
begin
  if not has_auth then
    raise notice 'Supabase roles not present — RLS policies skipped (Registry RPCs still enforce roles).';
    return;
  end if;

  for p in select * from jsonb_array_elements(policies) loop
    execute format('drop policy if exists %I on %I', p->>'name', p->>'tbl');
    execute format('create policy %I on %I for select to authenticated using (%s)',
                   p->>'name', p->>'tbl', p->>'using');
  end loop;

  -- Deliberately no INSERT/UPDATE/DELETE policies: the registry is only
  -- mutable through the audited SECURITY DEFINER functions below.

  execute 'grant usage on schema public to authenticated';
  execute 'grant select on persons, barangays, households, member_barangay_history,
           duplicate_cases, audit_logs, users, settings, import_batches, import_rows to authenticated';
  execute 'grant execute on all functions in schema public to authenticated';
  execute 'grant execute on function fn_link_auth_user() to authenticated';
end;
$rls$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all functions in schema public from anon';
  end if;
end $$;
