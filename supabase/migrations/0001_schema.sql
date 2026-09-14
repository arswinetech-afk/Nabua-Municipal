-- =====================================================================
-- NMBR — Nabua Municipal Barangay Registry
-- 0001_schema.sql — Central person registry schema
--
-- Design rule #1: THERE IS ONE MASTER PERSON REGISTRY.
-- Barangays do not own separate member tables. A person belongs to exactly
-- one master row; barangay residency is a time-bounded history.
--
-- Design rule #2: records are never hard-deleted by the application.
-- Use status = ACTIVE | INACTIVE | TRANSFERRED | DECEASED | FOR_REVIEW | ARCHIVED.
--
-- Design rule #3: every record carries a deterministic identity key
-- (fn_identity_key) which is protected by a unique index. Fuzzy matching
-- (fn_check_person_duplicates) runs BEFORE that guard so that legitimate
-- same-name neighbours are surfaced and resolved by a human instead of being
-- silently blocked or silently duplicated.
-- =====================================================================

do $$ begin
  begin
    create extension if not exists "pgcrypto";       -- gen_random_uuid(), crypt()
  exception when others then
    raise notice 'pgcrypto unavailable — relying on built-in gen_random_uuid()';
  end;
  begin
    create extension if not exists "pg_trgm";        -- optional: fast fuzzy index
  exception when others then
    raise notice 'pg_trgm unavailable — falling back to procedural similarity only';
  end;
end $$;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
do $$ begin
  create type person_status as enum ('ACTIVE','INACTIVE','TRANSFERRED','DECEASED','FOR_REVIEW','ARCHIVED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_role as enum ('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
exception when duplicate_object then null; end $$;

do $$ begin
  create type duplicate_status as enum ('PENDING','MERGED','DIFFERENT_PERSON','KEPT_BOTH','DEFERRED','DISMISSED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type transfer_reason as enum ('RESIDENT_TRANSFER','ADMINISTRATIVE_CORRECTION','OTHER');
exception when duplicate_object then null; end $$;

do $$ begin
  create type match_band as enum ('VERY_LIKELY','POSSIBLE','POTENTIAL','DISTINCT');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Reference: BARANGAY
-- ---------------------------------------------------------------------
create table if not exists barangays (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  municipality  text not null default 'Nabua',
  province      text not null default 'Camarines Sur',
  district      text,
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint barangays_unique_name unique (municipality, name),
  constraint barangays_name_not_blank check (length(btrim(name)) > 0)
);

-- ---------------------------------------------------------------------
-- Reference: USERS  (application profile; auth lives in auth.users on Supabase)
-- ---------------------------------------------------------------------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,
  name          text not null,
  email         text not null unique,
  password_hash text,                       -- only used by the offline/local backend
  role          user_role not null default 'ENCODER',
  active        boolean not null default true,
  barangay_scope uuid references barangays(id) on delete set null,
  last_login    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint users_email_lower_chk check (email = lower(email))
);

do $$ begin
  if to_regclass('auth.users') is not null then
    begin
      alter table users
        add constraint users_auth_user_fk
        foreign key (auth_user_id) references auth.users(id) on delete set null;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Core: PERSON  (the single master registry)
-- ---------------------------------------------------------------------
create sequence if not exists person_ref_seq start 2417;

create table if not exists persons (
  id             uuid primary key default gen_random_uuid(),
  reference_no   text not null unique
                 default 'NMBR-' || lpad(nextval('person_ref_seq')::text, 6, '0'),
  first_name     text not null,
  middle_name    text,
  last_name      text not null,
  suffix         text,
  date_of_birth  date,
  sex            text check (sex is null or sex in ('MALE','FEMALE')),
  civil_status   text check (civil_status is null or civil_status in
                   ('SINGLE','MARRIED','WIDOWED','SEPARATED','ANNULLED','UNKNOWN')),
  contact_number text,
  address        text,
  purok          text,
  barangay_id    uuid references barangays(id) on delete restrict,
  status         person_status not null default 'ACTIVE',
  remarks        text,
  household_id   uuid,

  -- deterministic identity guard (see 0003_guard.sql)
  identity_key   text not null default '',
  identity_lock  boolean not null default true,

  -- normalised search columns (never edited directly — see fn_persons_sync_columns)
  name_search    text not null default '',
  last_search    text not null default '',
  first_search   text not null default '',
  contact_search text not null default '',
  phonetic_key   text not null default '',   -- blocking key that survives typos

  merged_into    uuid references persons(id) on delete set null,
  merged_at      timestamptz,
  archived_at    timestamptz,

  client_ref     uuid,                      -- idempotency key for offline sync
  created_by     uuid references users(id) on delete set null,
  updated_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint persons_first_not_blank check (length(btrim(first_name)) > 0),
  constraint persons_last_not_blank  check (length(btrim(last_name)) > 0),
  constraint persons_dob_sane        check (date_of_birth is null
                                            or (date_of_birth > '1900-01-01' and date_of_birth < now()::date + interval '1 day')),
  constraint persons_not_self_merged check (merged_into is null or merged_into <> id)
);

create unique index if not exists persons_client_ref_uidx on persons (client_ref) where client_ref is not null;
create index if not exists persons_barangay_idx    on persons (barangay_id);
create index if not exists persons_status_idx      on persons (status);
create index if not exists persons_last_search_idx on persons (last_search text_pattern_ops);
create index if not exists persons_first_search_idx on persons (first_search text_pattern_ops);
create index if not exists persons_contact_idx     on persons (contact_search);
create index if not exists persons_updated_idx     on persons (updated_at desc);
create index if not exists persons_dob_idx         on persons (date_of_birth);
create index if not exists persons_merged_into_idx on persons (merged_into);

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index if not exists persons_name_trgm_idx on persons using gin (name_search gin_trgm_ops)';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- HOUSEHOLD (grouping, optional but part of the member profile)
-- ---------------------------------------------------------------------
create table if not exists households (
  id             uuid primary key default gen_random_uuid(),
  household_no   text not null unique,
  barangay_id    uuid not null references barangays(id) on delete restrict,
  address        text,
  purok          text,
  head_person_id uuid references persons(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'persons_household_fk') then
    alter table persons add constraint persons_household_fk
      foreign key (household_id) references households(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- MEMBER_BARANGAY_HISTORY — a person may move; the person row stays single
-- ---------------------------------------------------------------------
create table if not exists member_barangay_history (
  id             uuid primary key default gen_random_uuid(),
  person_id      uuid not null references persons(id) on delete cascade,
  barangay_id    uuid not null references barangays(id) on delete restrict,
  effective_from date not null default current_date,
  effective_to   date,
  status         text not null default 'ACTIVE',
  reason         transfer_reason,
  notes          text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint mbh_dates_sane check (effective_to is null or effective_to >= effective_from)
);

create index if not exists mbh_person_idx   on member_barangay_history (person_id, effective_from desc);
create index if not exists mbh_barangay_idx on member_barangay_history (barangay_id);
create unique index if not exists mbh_one_current_idx
  on member_barangay_history (person_id) where effective_to is null;

-- ---------------------------------------------------------------------
-- AUDIT_LOG — append only
-- ---------------------------------------------------------------------
create table if not exists audit_logs (
  id            bigserial primary key,
  user_id       uuid references users(id) on delete set null,
  user_name     text,
  user_role     user_role,
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  entity_label  text,
  old_values    jsonb,
  new_values    jsonb,
  changed_fields text[],
  reason        text,
  session_info  jsonb,
  timestamp     timestamptz not null default now()
);

create index if not exists audit_timestamp_idx on audit_logs (timestamp desc);
create index if not exists audit_entity_idx    on audit_logs (entity_type, entity_id);
create index if not exists audit_user_idx      on audit_logs (user_id, timestamp desc);
create index if not exists audit_action_idx    on audit_logs (action);

-- ---------------------------------------------------------------------
-- DUPLICATE_CASE — every duplicate finding that needs a human decision
-- ---------------------------------------------------------------------
create table if not exists duplicate_cases (
  id              uuid primary key default gen_random_uuid(),
  person_id_a     uuid not null references persons(id) on delete cascade,
  person_id_b     uuid not null references persons(id) on delete cascade,
  match_score     numeric(5,2) not null,
  match_band      match_band not null default 'POSSIBLE',
  matching_fields text[] not null default '{}',
  matched_details jsonb,
  status          duplicate_status not null default 'PENDING',
  source          text not null default 'MANUAL',   -- MANUAL | IMPORT | LIVE_CHECK | BACKGROUND
  batch_id        uuid,
  reviewed_by     uuid references users(id) on delete set null,
  reviewed_by_name text,
  reviewed_at     timestamptz,
  resolution      text,
  notes           text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint duplicate_pair_order check (person_id_a <> person_id_b)
);

create unique index if not exists duplicate_pair_uidx on duplicate_cases (
  least(person_id_a, person_id_b), greatest(person_id_a, person_id_b)
);
create index if not exists duplicate_status_idx on duplicate_cases (status, match_score desc);
create index if not exists duplicate_person_a_idx on duplicate_cases (person_id_a);
create index if not exists duplicate_person_b_idx on duplicate_cases (person_id_b);

-- ---------------------------------------------------------------------
-- IMPORT_BATCH / IMPORT_ROW — staging area for Excel/CSV bulk import
-- ---------------------------------------------------------------------
create table if not exists import_batches (
  id             uuid primary key default gen_random_uuid(),
  file_name      text not null,
  total_rows     int not null default 0,
  new_rows       int not null default 0,
  duplicate_rows int not null default 0,
  error_rows     int not null default 0,
  imported_rows  int not null default 0,
  status         text not null default 'VALIDATED',  -- VALIDATED | IMPORTED | CANCELLED
  mapping        jsonb,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  committed_at   timestamptz
);

create table if not exists import_rows (
  id             bigserial primary key,
  batch_id       uuid not null references import_batches(id) on delete cascade,
  row_no         int not null,
  raw            jsonb not null,
  normalized     jsonb not null,
  validation     jsonb not null default '{}'::jsonb,
  issues         text[] not null default '{}',
  severity       text not null default 'OK',          -- OK | WARNING | ERROR
  match_score    numeric(5,2),
  match_person_id uuid references persons(id) on delete set null,
  decision       text not null default 'PENDING',      -- PENDING | IMPORT | SKIP | LINK
  imported_person_id uuid references persons(id) on delete set null
);

create index if not exists import_rows_batch_idx on import_rows (batch_id, row_no);
create index if not exists import_rows_sev_idx   on import_rows (batch_id, severity);

-- ---------------------------------------------------------------------
-- SETTINGS — configurable duplicate rules (requirement 6)
-- ---------------------------------------------------------------------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('duplicate_weights', '{"last_name":26,"first_name":22,"middle_name":8,"date_of_birth":20,"sex":5,"barangay":6,"address":8,"contact":5}'::jsonb),
  ('duplicate_thresholds', '{"block":95,"warn":80,"notice":60}'::jsonb),
  ('system', '{"session_timeout_minutes":30,"mask_contact_in_lists":true,"block_on_very_likely":true,"require_reason_on_edit":true,"municipality":"Nabua","province":"Camarines Sur"}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- HARD DUPLICATE PROTECTION AT THE DATABASE LEVEL.
-- A partial unique index on the identity key stops two administrators from
-- creating the same person at the same time (acceptance test 6): the second
-- transaction gets a unique_violation which the API layer converts into a
-- friendly duplicate warning. Archived / merged rows are excluded so the
-- master row is the only live holder of the key.
-- ---------------------------------------------------------------------
create unique index if not exists persons_identity_key_uidx
  on persons (identity_key)
  where (status <> 'ARCHIVED' and merged_into is null);
