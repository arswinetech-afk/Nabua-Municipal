-- =====================================================================
--  NABUA MUNICIPAL BARANGAY REGISTRY (NMBR) — BOOTSTRAP FIRST ADMIN
--
--  WHEN YOU NEED THIS
--    The sign-in page answers "Incorrect email address or password" for
--    everybody, because no staff account exists yet: the demonstration
--    logins were never real Supabase accounts (they only ever worked
--    against the on-device registry), and a production build neither
--    prints them nor seeds them.
--
--  THE RULE TO REMEMBER
--    A person can sign in only when BOTH halves exist and match:
--      1. a login  in Supabase Authentication (e-mail + password), and
--      2. a profile in the public.users table (name, e-mail, role).
--    The sign-in links the two automatically by e-mail (migration 0009).
--    Residents ("members") are RECORDS in the registry — they never sign
--    in; only office staff have accounts.
--
--  STEP 1 — create the LOGIN (Supabase dashboard, not SQL)
--    Dashboard → Authentication → Users → "Add user":
--      • e-mail: the official address you will sign in with
--      • password: a strong temporary password
--      • tick "Auto confirm user"
--    Only the dashboard should create password logins; it stores the
--    password hash the supported way and keeps the auth schema intact.
--
--  STEP 2 — create the PROFILE (this file, SQL Editor)
--    Edit the two values in the INSERT below (e-mail in LOWER CASE and
--    exactly the same as in step 1), paste the file, run it once.
--
--  STEP 3 — sign in on the app with those credentials.
--    The first sign-in links login ↔ profile and you are in as
--    SYSTEM_ADMIN. Change the temporary password afterwards
--    (Authentication → Users → update user), then create the rest of the
--    team from the Users page inside the app (docs/GO_LIVE.md §4).
--
--  This file is safe: it refuses to run a second time for the same
--  e-mail (unique constraint) and touches nothing else.
-- =====================================================================

-- Safety net: bootstrap closes forever once somebody has actually SIGNED IN
-- (an active profile that is linked to an auth login). Profiles that merely
-- exist — including one created by mistake with the placeholder values —
-- do not close the window; fix or remove them and run this file again:
--
--   fix in place:  update users set name = 'Real Name', email = 'real@nabua.gov.ph'
--                    where email = 'wrong@...';
--   or remove:     delete from users where email = 'wrong@...' and auth_user_id is null;
--
-- From the moment a real sign-in exists, accounts must be created inside the
-- app by an administrator, so the audit trail shows who created whom.
do $$ begin
  if exists (select 1 from users where active and auth_user_id is not null) then
    raise exception
      'BOOTSTRAP_REFUSED: somebody has already signed in (%) — create further accounts from the Users page inside the app.',
      (select email from users where active and auth_user_id is not null
        order by last_login desc nulls last limit 1)
      using errcode = 'P0002';
  end if;
end $$;

-- ▼▼▼ edit these two values ▼▼▼
-- The placeholders are UPPER CASE on purpose: if this file is run unedited,
-- the insert fails on the users lower-case e-mail check instead of creating
-- a junk profile that a later, correct run would trip over.
insert into users (name, email, role, active)
values (
  'YOUR FULL NAME',              -- ← real name, as it should appear in the audit log
  'YOUR.NAME@NABUA.GOV.PH',      -- ← LOWER CASE, exactly the e-mail used in step 1
  'SYSTEM_ADMIN',                -- first account should be SYSTEM_ADMIN
  true
);
-- ▲▲▲ edit these two values ▲▲▲

-- Verify: one active profile, not yet linked (linking happens at sign-in).
select email, name, role, active,
       case when auth_user_id is null then 'not linked yet — sign in once to link'
            else 'linked' end as link_state
  from users;
