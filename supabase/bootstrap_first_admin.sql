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

-- Safety net: if any ACTIVE profile already exists, stop — from that point
-- on accounts must be created inside the app by an administrator, so the
-- audit trail shows who created whom.
do $$ begin
  if exists (select 1 from users where active) then
    raise exception
      'BOOTSTRAP_REFUSED: an active profile already exists (%) — create further accounts from the Users page inside the app.',
      (select email from users where active order by created_at limit 1)
      using errcode = 'P0002';
  end if;
end $$;

-- ▼▼▼ edit these two values ▼▼▼
insert into users (name, email, role, active)
values (
  'Your Full Name',                 -- ← real name, as it should appear in the audit log
  'your.name@nabua.gov.ph',         -- ← LOWER CASE, exactly the e-mail used in step 1
  'SYSTEM_ADMIN',                   -- first account should be SYSTEM_ADMIN
  true
);
-- ▲▲▲ edit these two values ▲▲▲

-- Verify: one active profile, not yet linked (linking happens at sign-in).
select email, name, role, active,
       case when auth_user_id is null then 'not linked yet — sign in once to link'
            else 'linked' end as link_state
  from users;
