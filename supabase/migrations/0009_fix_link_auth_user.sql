-- =====================================================================
-- NMBR — 0009_fix_link_auth_user.sql
-- Repairs the auth-user → profile linking used at every sign-in.
--
-- FIELD REPORT (go-live blocking): real staff accounts could not sign in to
-- the municipal server. Supabase accepted the password, then the sign-in died
-- inside fn_link_auth_user() and the app silently fell back to the on-device
-- registry. Every change made afterwards was queued and then refused by the
-- guard triggers with "NMBR_UNAUTHENTICATED: Your session is not recognised",
-- retrying forever (see the Sync Centre report of 2026-09-15).
--
-- Two faults in the previous body of the function:
--
--   1. `select * into u from users where lower(email) = lower(email) ...`
--      compares the column with ITSELF (always true) instead of comparing the
--      profile email with the email of the authenticated Supabase account, so
--      even when it ran it would have linked the sign-in to an arbitrary
--      unlinked profile — the wrong role and the wrong name in the audit log.
--
--   2. In that statement the bare name `email` is both a PL/pgSQL variable and
--      a column of `users`. With the default plpgsql.variable_conflict =
--      'error' PostgreSQL refuses to plan it at all ("column reference
--      \"email\" is ambiguous"), so EVERY first sign-in of an account that was
--      not pre-linked failed. Only profiles linked by hand in the database
--      (the demonstration accounts) ever reached the early-return branch.
--
-- The repaired function qualifies every column and keeps the authentication
-- email in a distinctly named variable, so the match is unambiguous and
-- correct: an authenticated account is linked to the one active profile that
-- carries the same email address, and to nothing else.
--
-- Safe to re-run: create or replace function.
-- =====================================================================

create or replace function fn_link_auth_user()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := fn_auth_uid();
  v_profile users;
  v_auth_email text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Not authenticated.');
  end if;

  -- 1. Already linked profile: refresh the last login and return it.
  select * into v_profile from users where users.auth_user_id = v_uid limit 1;
  if found then
    update users set last_login = now() where users.id = v_profile.id;
    return jsonb_build_object('ok', true, 'user', jsonb_build_object(
      'id', v_profile.id, 'name', v_profile.name, 'email', v_profile.email,
      'role', v_profile.role, 'active', v_profile.active,
      'barangay_scope', v_profile.barangay_scope, 'last_login', now()));
  end if;

  -- 2. First sign-in of this Supabase account: read its email from auth.users
  --    and link the matching NMBR profile created by the administrator.
  begin
    execute 'select email from auth.users where id = $1' into v_auth_email using v_uid;
  exception when others then
    v_auth_email := null;
  end;

  if v_auth_email is null then
    return jsonb_build_object('ok', false, 'error', 'No profile is linked to this account.');
  end if;

  select * into v_profile
    from users
   where lower(users.email) = lower(v_auth_email)
     and users.auth_user_id is null
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error',
      'This account is not registered in the NMBR user list. Ask the system administrator to add you.');
  end if;
  if not v_profile.active then
    return jsonb_build_object('ok', false, 'error', 'This account has been deactivated.');
  end if;

  update users set auth_user_id = v_uid, last_login = now() where users.id = v_profile.id;
  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label, session_info)
  values (v_profile.id, v_profile.name, v_profile.role, 'LOGIN', 'USERS', v_profile.id, v_profile.name,
          fn_session_info());

  return jsonb_build_object('ok', true, 'user', jsonb_build_object(
    'id', v_profile.id, 'name', v_profile.name, 'email', v_profile.email,
    'role', v_profile.role, 'active', v_profile.active,
    'barangay_scope', v_profile.barangay_scope, 'last_login', now()));
end $$;

-- The grant list of 0007 already covers this function name; re-assert it so a
-- project that applied the migrations in an unusual order still works.
do $rls$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function fn_link_auth_user() to authenticated';
  end if;
end $rls$;
