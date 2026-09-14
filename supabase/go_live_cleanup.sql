-- =====================================================================
--  NABUA MUNICIPAL BARANGAY REGISTRY (NMBR) — GO-LIVE CLEANUP
--
--  PURPOSE
--    Run this ONCE, in the Supabase SQL Editor, before the office starts
--    encoding real residents. It removes every trace of the fictional
--    demonstration dataset (12 barangays, 160 members, demo households,
--    demo duplicate cases, demonstration accounts) so the municipality
--    begins with an empty, clean, auditable registry.
--
--  WHEN TO RUN
--    • After NMBR-supabase-setup.sql (or the in-app "Download setup SQL"),
--      including the 0009 sign-in linking repair.
--    • BEFORE the first real member is encoded. It deletes ALL members —
--      if real records already exist, do not run this file; archive or
--      merge instead, and remove the demonstration rows by hand.
--
--  SAFETY
--    • Idempotent: a second run finds nothing left to delete.
--    • Nothing here touches the schema, the duplicate guard, the RLS
--      policies or the settings; only data rows.
--    • The audit ledger is left intact by default (see the OPTIONAL
--      block at the bottom if the municipality wants a pristine ledger).
--
--  HOW TO USE
--    1. Supabase project → SQL Editor → New query.
--    2. Paste this whole file, press Run.
--    3. Continue with docs/GO_LIVE.md (create real barangays and accounts).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Imports and duplicate cases (reference members and would block)
-- ---------------------------------------------------------------------
delete from import_rows;
delete from import_batches;
delete from duplicate_cases;

-- ---------------------------------------------------------------------
-- 2. Barangay history, then the members themselves
-- ---------------------------------------------------------------------
delete from member_barangay_history;
update persons set merged_into = null where merged_into is not null;
delete from persons;

-- ---------------------------------------------------------------------
-- 3. Households (their head-person links were nulled by the FKs)
-- ---------------------------------------------------------------------
delete from households;

-- ---------------------------------------------------------------------
-- 4. Demonstration accounts: deactivated and unlinked, not deleted.
--
--    Why not DELETE: every audit entry keeps a foreign key to the user who
--    made it, and the audit log is immutable by design (RA 10173). Deleting
--    a user would force the foreign key to rewrite history (set null), which
--    the immutability trigger refuses — and rightly so. Deactivation gives
--    the same security result: an inactive profile cannot sign in
--    (fn_link_auth_user refuses it, and every role guard requires active),
--    cannot be linked to a Supabase login, and stays visible in the Users
--    page marked inactive, as an honest record of the training period.
--
--    Real staff profiles are added afterwards from the Users page.
-- ---------------------------------------------------------------------
update users
   set active = false,
       auth_user_id = null,
       barangay_scope = null
 where lower(email) in (
   'admin@nabua.gov.ph',
   'maria.santos@nabua.gov.ph',
   'josefina.ramos@nabua.gov.ph',
   'pedro.reyes@nabua.gov.ph',
   'ana.villanueva@nabua.gov.ph',
   'liza.mercado@nabua.gov.ph',
   'viewer@nabua.gov.ph'
 );

-- ---------------------------------------------------------------------
-- 5. Demonstration barangays — every real one is added afterwards from
--    the Barangays page (or with the template below).
-- ---------------------------------------------------------------------
delete from barangays;

-- ---------------------------------------------------------------------
-- 6. Reference numbers start at NMBR-000001 for the first real resident.
-- ---------------------------------------------------------------------
alter sequence if exists person_ref_seq restart with 1;

commit;

-- =====================================================================
--  NEXT: CREATE THE REAL BARANGAYS
--  Either use the Barangays page (Settings menu → Barangays → Add), or
--  paste the official PSA/PSGC list of the municipality's barangays here
--  and run it:
--
--  insert into barangays (name, municipality, province, district) values
--    ('<Barangay name 1>', 'Nabua', 'Camarines Sur', '<district or 1>'),
--    ('<Barangay name 2>', 'Nabua', 'Camarines Sur', '<district or 1>'),
--    ...
--    ('<Barangay name N>', 'Nabua', 'Camarines Sur', '<district or N>');
--
--  Use the official names exactly as published (including punctuation
--  such as "Sto. Niño"), because reports and certificates print them.
-- =====================================================================

-- =====================================================================
--  OPTIONAL — a pristine audit ledger.
--  The audit log is immutable by design (RA 10173 accountability): rows
--  cannot be updated or deleted, and the demonstration period left
--  entries behind. TRUNCATE bypasses the row triggers, so it is the only
--  way to start the ledger empty. Do this ONLY if the municipality
--  accepts losing the demonstration-period history, and only BEFORE any
--  real access happens:
--
--  truncate table audit_logs;
--
--  OPTIONAL — remove the demonstration logins from Supabase
--  Authentication as well (the profiles are already deactivated; without
--  this the demo e-mails could still authenticate but reach no profile):
--
--  delete from auth.users where email in (
--    'admin@nabua.gov.ph','maria.santos@nabua.gov.ph',
--    'josefina.ramos@nabua.gov.ph','pedro.reyes@nabua.gov.ph',
--    'ana.villanueva@nabua.gov.ph','liza.mercado@nabua.gov.ph',
--    'viewer@nabua.gov.ph');
--
--  OPTIONAL — physically delete the deactivated demonstration profiles.
--  Only if the municipality accepts that the audit entries of the training
--  period lose their user_id pointer (user_name and role stay written in
--  each entry). This briefly suspends the immutability trigger because the
--  foreign key must set those pointers to null:
--
--  alter table audit_logs disable trigger trg_audit_immutable;
--  delete from users where active = false and lower(email) in (
--    'admin@nabua.gov.ph','maria.santos@nabua.gov.ph',
--    'josefina.ramos@nabua.gov.ph','pedro.reyes@nabua.gov.ph',
--    'ana.villanueva@nabua.gov.ph','liza.mercado@nabua.gov.ph',
--    'viewer@nabua.gov.ph');
--  alter table audit_logs enable trigger trg_audit_immutable;
-- =====================================================================
