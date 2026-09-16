-- =====================================================================
--  NABUA MUNICIPAL BARANGAY REGISTRY (NMBR)
--  Centralized Member Registry & Duplicate Prevention System
--
--  DATABASE SETUP — run this once on the Supabase project.
--
--  HOW TO USE
--    1. Open the Supabase project.
--    2. Left menu -> SQL Editor -> New query.
--    3. Copy this whole file, paste it in, press Run.
--    4. Wait for "Success. No rows returned".
--    5. Back in the NMBR app, press "Check the server again" in the Sync
--       Centre: everything that was queued on the device uploads by itself.
--
--  This file is safe to run more than once — every statement is idempotent.
--  It contains no secrets and no resident data: only the tables, the duplicate
--  matching functions, the audit triggers, the row level security policies and
--  the stored procedures the application calls.
--
--  Built from these migration files, in this order (the file is reproducible:
--  the same sources always produce byte-identical output):
--      supabase/migrations/0001_schema.sql
--      supabase/migrations/0002_functions.sql
--      supabase/migrations/0003_guard_triggers.sql
--      supabase/migrations/0004_rpc_registry.sql
--      supabase/migrations/0005_rpc_duplicates.sql
--      supabase/migrations/0006_rpc_import_admin.sql
--      supabase/migrations/0007_security_rls.sql
--      supabase/migrations/0008_health.sql
--      supabase/migrations/0009_fix_link_auth_user.sql
--      supabase/migrations/0010_search_created_since.sql
-- =====================================================================



-- #####################################################################
-- # 0001_schema.sql
-- #####################################################################

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


-- #####################################################################
-- # 0002_functions.sql
-- #####################################################################

-- =====================================================================
-- NMBR — 0002_functions.sql
-- Normalisation, fuzzy similarity and duplicate scoring.
--
-- The logic here is intentionally a mirror of src/lib/duplicateEngine.ts so
-- that the offline (browser) check and the authoritative (database) check
-- produce the same verdict. Change one, change the other.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Normalisation
-- ---------------------------------------------------------------------
create or replace function fn_norm_text(t text)
returns text language sql immutable parallel safe as $$
  select coalesce(
    nullif(
      btrim(
        regexp_replace(
          upper(translate(coalesce(t,''),
            'áàâãäåéèêëíìîïóòôõöúùûüñçÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
            'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC')),
          '[^A-Z0-9]+', ' ', 'g')),
      ''),
    '')
$$;

create or replace function fn_norm_name(t text)
returns text language sql immutable parallel safe as $$ select fn_norm_text(t) $$;

create or replace function fn_norm_digits(t text)
returns text language sql immutable parallel safe as $$
  select coalesce(regexp_replace(coalesce(t,''), '[^0-9]+', '', 'g'), '')
$$;

-- PH contact normalisation: 09171234567, +63 917 123 4567, 639171234567 -> 9171234567
create or replace function fn_norm_contact(t text)
returns text language sql immutable parallel safe as $$
  with d as (select fn_norm_digits(t) as digits)
  select case
    when digits = '' then ''
    when length(digits) > 10 and left(digits, 2) = '63' then substring(digits from 3)
    when left(digits, 1) = '0' then substring(digits from 2)
    else digits
  end from d
$$;

-- Accepts ISO, PH (01/12/1985) and most human formats. Returns null when unusable.
create or replace function fn_norm_date(t text)
returns date language plpgsql immutable as $$
declare
  s text := btrim(coalesce(t,''));
  m text[];
  a int; b int; y int; tmp int;
begin
  if s = '' then return null; end if;
  if s ~ '^\d{4}-\d{1,2}-\d{1,2}' then
    begin return substring(s from 1 for 10)::date; exception when others then return null; end;
  end if;
  m := regexp_match(s, '^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$');
  if m is not null then
    a := m[1]::int; b := m[2]::int; y := m[3]::int;
    if y < 100 then y := y + case when y > 30 then 1900 else 2000 end; end if;
    if a > 12 and b <= 12 then tmp := a; a := b; b := tmp; end if;
    if a < 1 or a > 12 or b < 1 or b > 31 then return null; end if;
    begin
      return make_date(y, a, b);
    exception when others then
      return null;
    end;
  end if;
  begin
    return s::timestamptz::date;
  exception when others then
    return null;
  end;
end $$;

-- Deterministic identity key. MUST stay identical to identityKey() in TypeScript.
create or replace function fn_identity_key(
  p_first text, p_middle text, p_last text, p_suffix text, p_dob date)
returns text language sql immutable parallel safe as $$
  select concat_ws('|',
    fn_norm_name(p_last),
    fn_norm_name(p_first),
    fn_norm_name(p_middle),
    fn_norm_name(p_suffix),
    coalesce(p_dob::text, ''))
$$;

-- ---------------------------------------------------------------------
-- Similarity primitives (no extensions required — pg_trgm is optional)
-- ---------------------------------------------------------------------
create or replace function fn_bigrams(t text)
returns text[] language sql immutable parallel safe as $$
  select coalesce(array_agg(substring(' ' || t || ' ' from i for 2)), '{}'::text[])
  from generate_series(1, greatest(length(' ' || t || ' ') - 1, 0)) as i
$$;

-- Dice coefficient over character bigrams (same family as pg_trgm similarity())
create or replace function fn_similarity(a text, b text)
returns numeric language plpgsql immutable as $$
declare
  ga text[]; gb text[]; matches int := 0; i int; j int; used boolean[];
begin
  a := coalesce(a,''); b := coalesce(b,'');
  if a = '' or b = '' then return 0; end if;
  if a = b then return 1; end if;
  ga := fn_bigrams(a); gb := fn_bigrams(b);
  used := array_fill(false, array[array_length(gb,1)]);
  for i in 1 .. coalesce(array_length(ga,1),0) loop
    for j in 1 .. coalesce(array_length(gb,1),0) loop
      if not used[j] and ga[i] = gb[j] then
        used[j] := true; matches := matches + 1; exit;
      end if;
    end loop;
  end loop;
  return round((2.0 * matches) / (array_length(ga,1) + array_length(gb,1))::numeric, 4);
end $$;

-- Token-set similarity with a containment bonus:
-- 'JUAN CRUZ' vs 'JUAN SANTOS CRUZ' must score high (incomplete middle name case).
create or replace function fn_token_similarity(a text, b text)
returns numeric language plpgsql immutable as $$
declare
  ta text[]; tb text[]; inter int := 0; union_n int; t text;
begin
  a := coalesce(a,''); b := coalesce(b,'');
  if a = '' or b = '' then return 0; end if;
  if a = b then return 1; end if;
  ta := string_to_array(a, ' '); tb := string_to_array(b, ' ');
  foreach t in array ta loop
    if t = any(tb) then inter := inter + 1; end if;
  end loop;
  if inter = 0 then return 0; end if;
  union_n := array_length(ta,1) + array_length(tb,1) - inter;
  return greatest(
    round(inter::numeric / greatest(union_n,1), 4),
    case when inter = least(array_length(ta,1), array_length(tb,1)) then 0.85 else 0 end
  );
end $$;

-- Lightweight phonetic key (survives common Filipino name spelling variants)
create or replace function fn_phonetic(t text)
returns text language plpgsql immutable as $$
declare
  words text[]; w text; out_parts text[] := '{}'; x text;
begin
  t := fn_norm_text(t);
  if t = '' then return ''; end if;
  words := string_to_array(t, ' ');
  foreach w in array words loop
    x := w;
    x := regexp_replace(x, '^(KN|GN|PN|WR|PS)', '\1');
    x := regexp_replace(x, '^X', 'S');
    x := regexp_replace(x, 'C(Q|E|I|Y)', 'S');
    x := regexp_replace(x, 'PH', 'F');
    x := regexp_replace(x, 'GH', 'H');
    x := regexp_replace(x, 'TH', '0');
    x := regexp_replace(x, '[AEIOUY]', '', 'g');
    x := regexp_replace(x, '(.)\1+', '\1', 'g');
    x := left(x, 4);
    if x <> '' then out_parts := out_parts || x; end if;
  end loop;
  return array_to_string(out_parts, '');
end $$;

-- Name field similarity -> {score, reason}; mirror of nameFieldSimilarity()
create or replace function fn_name_similarity(a text, b text)
returns jsonb language plpgsql immutable as $$
declare
  x text := fn_norm_name(a);
  y text := fn_norm_name(b);
  tri numeric; tok numeric; s numeric;
begin
  if x = '' or y = '' then return jsonb_build_object('score', 0.5, 'reason', 'unknown'); end if;
  if x = y then return jsonb_build_object('score', 1, 'reason', 'exact'); end if;
  tri := fn_similarity(x, y);
  tok := fn_token_similarity(x, y);
  s := greatest(tri, tok);
  if s < 0.92 and fn_phonetic(x) <> '' and fn_phonetic(x) = fn_phonetic(y) then
    return jsonb_build_object('score', greatest(s, 0.88), 'reason', 'phonetic');
  end if;
  if s >= 0.9 then return jsonb_build_object('score', s, 'reason', 'near'); end if;
  if s >= 0.72 then return jsonb_build_object('score', s, 'reason', 'partial'); end if;
  if s >= 0.5 then return jsonb_build_object('score', s, 'reason', 'weak'); end if;
  return jsonb_build_object('score', s, 'reason', 'mismatch');
end $$;

-- ---------------------------------------------------------------------
-- Configuration helpers
-- ---------------------------------------------------------------------
create or replace function fn_setting(p_key text, p_default jsonb)
returns jsonb language sql stable as $$
  select coalesce((select value from settings where key = p_key), p_default)
$$;

create or replace function fn_duplicate_weights()
returns jsonb language sql stable as $$
  select fn_setting('duplicate_weights',
    '{"last_name":26,"first_name":22,"middle_name":8,"date_of_birth":20,"sex":5,"barangay":6,"address":8,"contact":5}'::jsonb)
$$;

create or replace function fn_duplicate_thresholds()
returns jsonb language sql stable as $$
  select fn_setting('duplicate_thresholds', '{"block":95,"warn":80,"notice":60}'::jsonb)
$$;

create or replace function fn_band_for(p_score numeric, p_thresholds jsonb default null)
returns match_band language plpgsql immutable as $$
declare
  t jsonb := coalesce(p_thresholds, '{"block":95,"warn":80,"notice":60}'::jsonb);
begin
  if p_score >= coalesce((t->>'block')::numeric, 95) then return 'VERY_LIKELY'; end if;
  if p_score >= coalesce((t->>'warn')::numeric, 80) then return 'POSSIBLE'; end if;
  if p_score >= coalesce((t->>'notice')::numeric, 60) then return 'POTENTIAL'; end if;
  return 'DISTINCT';
end $$;

-- ---------------------------------------------------------------------
-- Scoring: candidate (jsonb) vs one stored person row
-- ---------------------------------------------------------------------
create or replace function fn_score_pair(
  c jsonb,
  e persons,
  p_weights jsonb default null,
  p_thresholds jsonb default null)
returns jsonb language plpgsql stable as $$
begin
  return fn_score_json(
    c,
    fn_person_index_json(e) || jsonb_build_object('barangay_name', fn_person_barangay_name(e),
                                                  'identity_key', e.identity_key),
    p_weights, p_thresholds);
end $$;

-- ---------------------------------------------------------------------
-- Scoring core: candidate (jsonb) vs existing record (jsonb).
-- Used for live checks, import validation (file-vs-file and file-vs-registry)
-- and the comparison screen.
-- ---------------------------------------------------------------------
create or replace function fn_score_json(
  c jsonb,
  e jsonb,
  p_weights jsonb default null,
  p_thresholds jsonb default null)
returns jsonb language plpgsql stable as $$
declare
  w jsonb := coalesce(p_weights, fn_duplicate_weights());
  th jsonb := coalesce(p_thresholds, fn_duplicate_thresholds());
  wt_last numeric := coalesce((w->>'last_name')::numeric, 26);
  wt_first numeric := coalesce((w->>'first_name')::numeric, 22);
  wt_mid numeric := coalesce((w->>'middle_name')::numeric, 8);
  wt_dob numeric := coalesce((w->>'date_of_birth')::numeric, 20);
  wt_sex numeric := coalesce((w->>'sex')::numeric, 5);
  wt_brgy numeric := coalesce((w->>'barangay')::numeric, 6);
  wt_addr numeric := coalesce((w->>'address')::numeric, 8);
  wt_contact numeric := coalesce((w->>'contact')::numeric, 5);

  c_last text := fn_norm_name(c->>'last_name');
  c_first text := fn_norm_name(c->>'first_name');
  c_mid text := fn_norm_name(c->>'middle_name');
  c_sex text := fn_norm_text(c->>'sex');
  c_dob date := fn_norm_date(c->>'date_of_birth');
  c_key text := fn_identity_key(c->>'first_name', c->>'middle_name', c->>'last_name', c->>'suffix', c_dob);
  c_contact text := fn_norm_contact(c->>'contact_number');
  c_brgy text := fn_norm_text(coalesce(c->>'barangay_name', c->>'barangay', ''));
  c_addr text := fn_norm_text(coalesce(c->>'purok','') || ' ' || coalesce(c->>'address',''));

  e_last text := fn_norm_name(e->>'last_name');
  e_first text := fn_norm_name(e->>'first_name');
  e_mid text := fn_norm_name(e->>'middle_name');
  e_sex text := fn_norm_text(e->>'sex');
  e_dob date := fn_norm_date(e->>'date_of_birth');
  e_key text := coalesce(nullif(e->>'identity_key',''),
                         fn_identity_key(e->>'first_name', e->>'middle_name', e->>'last_name', e->>'suffix', e_dob));
  e_contact text := coalesce(nullif(fn_norm_contact(e->>'contact_number'), ''), fn_norm_contact(e->>'contact_search'));
  e_brgy text := fn_norm_text(coalesce(e->>'barangay_name', ''));
  e_addr text := fn_norm_text(coalesce(e->>'purok','') || ' ' || coalesce(e->>'address',''));
  e_status text := coalesce(e->>'status', 'ACTIVE');

  j_last jsonb; j_first jsonb; j_mid jsonb;
  s_last numeric; s_first numeric; s_mid numeric;
  s_dob numeric; dob_unknown boolean; dob_conflict boolean;
  sex_unknown boolean; sex_conflict boolean; s_sex numeric;
  s_brgy numeric; s_addr numeric;
  contact_match boolean; contact_both boolean; contact_unknown boolean; s_contact numeric;

  total numeric := 0; score numeric;
  reasons jsonb := '[]'::jsonb;
  flags jsonb;
  identity_match boolean;
  capped text := '';
begin
  if e_status = 'ARCHIVED' or (e->>'merged_into') is not null then
    return jsonb_build_object('score', 0, 'band', 'DISTINCT', 'reasons', '[]'::jsonb,
                              'matched_fields', '[]'::jsonb, 'flags', '{"skipped":true}'::jsonb);
  end if;

  identity_match := (c_key <> '||||' and c_key = e_key and c_dob is not null and c_last <> '');

  j_last  := fn_name_similarity(c->>'last_name',  e_last);
  j_first := fn_name_similarity(c->>'first_name', e_first);
  j_mid   := fn_name_similarity(c->>'middle_name', e_mid);
  s_last  := (j_last->>'score')::numeric;
  s_first := (j_first->>'score')::numeric;
  s_mid   := (j_mid->>'score')::numeric;

  dob_unknown := (c_dob is null or e_dob is null);
  dob_conflict := (c_dob is not null and e_dob is not null and c_dob <> e_dob);
  s_dob := case when dob_unknown then 0.45 when dob_conflict then 0 when c_dob = e_dob then 1 else 0.45 end;
  if c_dob is not null and e_dob is not null and c_dob = e_dob then
    s_dob := 1;
  end if;

  sex_unknown := (c_sex = '' or e_sex = '' or c_sex = 'UNKNOWN');
  sex_conflict := (not sex_unknown and c_sex <> e_sex);
  s_sex := case when sex_unknown then 0.5 when sex_conflict then 0 else 1 end;

  s_brgy := case
              when c_brgy = '' or e_brgy = '' then 0.5
              when c_brgy = e_brgy then 1
              else 0 end;

  s_addr := case
              when c_addr = '' or e_addr = '' then 0.5
              else greatest(fn_similarity(c_addr, e_addr), fn_token_similarity(c_addr, e_addr))
            end;

  contact_match := (c_contact <> '' and e_contact <> '' and c_contact = e_contact and length(c_contact) >= 7);
  contact_both := (c_contact <> '' and e_contact <> '');
  contact_unknown := (c_contact = '' or e_contact = '');
  s_contact := case when contact_unknown then 0.5 when contact_match then 1 else 0.15 end;

  total := s_last*wt_last + s_first*wt_first + s_mid*wt_mid + s_dob*wt_dob
         + s_sex*wt_sex + s_brgy*wt_brgy + s_addr*wt_addr + s_contact*wt_contact;

  if identity_match then
    score := 100;
  else
    score := total;
    if contact_match then score := score + 8; end if;
    if contact_both and not contact_match then score := score * 0.96; end if;
    if dob_conflict then
      score := score * 0.75;
      score := least(score, 74);
      if s_last >= 0.95 and s_first >= 0.95 then score := greatest(score, 62); end if;
      capped := 'date_of_birth_conflict';
    end if;
    if sex_conflict then
      score := score * 0.65;
      score := least(score, 84);
      capped := case when capped = '' then 'sex_conflict' else capped || ',sex_conflict' end;
    end if;
    if dob_unknown and not dob_conflict then
      score := least(score, 88);
      capped := case when capped = '' then 'date_of_birth_unknown' else capped || ',date_of_birth_unknown' end;
    end if;
  end if;

  score := round(greatest(least(score, 100), 0), 2);

  reasons := jsonb_build_array(
    fn_reason('last_name','Last name', s_last, wt_last, c->>'last_name', e->>'last_name', j_last, false, false),
    fn_reason('first_name','First name', s_first, wt_first, c->>'first_name', e->>'first_name', j_first, false, false),
    fn_reason('middle_name','Middle name', s_mid, wt_mid, c->>'middle_name', e->>'middle_name', j_mid,
              (c_mid = '' or e_mid = ''), false),
    fn_reason('date_of_birth','Date of birth', s_dob, wt_dob, c->>'date_of_birth', e_dob::text,
              jsonb_build_object('score', s_dob, 'reason', case when dob_unknown then 'unknown' else 'exact' end),
              dob_unknown, dob_conflict),
    fn_reason('sex','Sex', s_sex, wt_sex, c->>'sex', e->>'sex',
              jsonb_build_object('score', s_sex, 'reason', case when sex_unknown then 'unknown' else 'exact' end),
              sex_unknown, sex_conflict),
    fn_reason('barangay','Barangay', s_brgy, wt_brgy, c_brgy, e->>'barangay_name',
              jsonb_build_object('score', s_brgy, 'reason', case when s_brgy = 1 then 'exact' else 'mismatch' end),
              (c_brgy = '' or e_brgy = ''), false),
    fn_reason('address','Address / Purok', s_addr, wt_addr, c_addr, e_addr,
              jsonb_build_object('score', s_addr, 'reason', case when s_addr >= 0.9 then 'near' else 'partial' end),
              (c_addr = '' or e_addr = ''), false),
    fn_reason('contact_number','Contact number', s_contact, wt_contact, c_contact, e_contact,
              jsonb_build_object('score', s_contact, 'reason', case when contact_match then 'exact' else 'mismatch' end),
              contact_unknown, false)
  );

  flags := jsonb_build_object(
    'identityMatch', identity_match,
    'dobConflict', dob_conflict,
    'sexConflict', sex_conflict,
    'dobUnknown', dob_unknown,
    'contactMatch', contact_match,
    'nameOnlyMatch', (s_last >= 0.95 and s_first >= 0.95 and (dob_conflict or dob_unknown)),
    'cappedBy', nullif(capped, '')
  );

  return jsonb_build_object(
    'score', score,
    'band', fn_band_for(score, th)::text,
    'reasons', reasons,
    'matched_fields', coalesce((select jsonb_agg(r->>'field') from jsonb_array_elements(reasons) r
                                where r->>'status' = 'match'), '[]'::jsonb),
    'flags', flags
  );
end $$;

-- Helper: reason object with status + human readable detail
create or replace function fn_reason(
  p_field text, p_label text, p_sim numeric, p_weight numeric,
  p_a text, p_b text, p_meta jsonb, p_unknown boolean, p_conflict boolean)
returns jsonb language plpgsql immutable as $$
declare
  st text; detail text; sim_round numeric := round(coalesce(p_sim,0), 2);
begin
  if p_conflict then st := 'conflict';
  elsif p_unknown then st := 'unknown';
  elsif sim_round >= 0.95 then st := 'match';
  elsif sim_round >= 0.6 then st := 'partial';
  else st := 'mismatch';
  end if;

  detail := case
    when p_conflict and p_field = 'date_of_birth' then
      'Different dates: ' || coalesce(to_char(fn_norm_date(p_a), 'MM/DD/YYYY'), '—')
        || ' vs ' || coalesce(to_char(fn_norm_date(p_b), 'MM/DD/YYYY'), '—')
    when p_conflict then coalesce(p_a,'—') || ' vs ' || coalesce(p_b,'—')
    when p_unknown then
      case when p_field = 'date_of_birth' then 'Date of birth missing on one record'
           when p_field = 'middle_name' then 'Middle name not recorded on one record'
           when p_field = 'contact_number' then 'Contact number missing on one record'
           when p_field = 'barangay' then 'Barangay not indicated'
           else 'Not recorded on one record' end
    when st = 'match' then
      case when p_field in ('date_of_birth','sex','barangay','contact_number') then
             case when p_field = 'date_of_birth' then 'Both ' || to_char(fn_norm_date(p_a), 'MM/DD/YYYY')
                  when p_field = 'barangay' then 'Same barangay (' || coalesce(p_b,'—') || ')'
                  when p_field = 'contact_number' then 'Contact numbers match'
                  else 'Both ' || coalesce(p_a,'') end
           else 'Exact match after normalisation' end
    else
      case when p_field = 'address' then 'Address similarity ' || round(sim_round*100) || '%'
           else case coalesce(p_meta->>'reason','')
                  when 'phonetic' then 'Sounds the same (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  when 'near' then round(sim_round*100) || '% similar (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  when 'partial' then 'Partially similar — ' || round(sim_round*100) || '% (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  when 'weak' then 'Weak similarity — ' || round(sim_round*100) || '% (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  else 'Different (' || coalesce(p_a,'—') || ' vs ' || coalesce(p_b,'—') || ')' end
           end
      end
  end;

  return jsonb_build_object(
    'field', p_field, 'label', p_label, 'status', st, 'similarity', sim_round,
    'weight', p_weight, 'detail', detail);
end $$;

-- Barangay name for a stored person row (used inside scoring)
create or replace function fn_person_barangay_name(p persons)
returns text language sql stable as $$
  select (select b.name from barangays b where b.id = p.barangay_id)
$$;


-- #####################################################################
-- # 0003_guard_triggers.sql
-- #####################################################################

-- =====================================================================
-- NMBR — 0003_guard_triggers.sql
-- Database-level duplicate protection, column maintenance and audit.
--
-- The unique index persons_identity_key_uidx is the final safety net, but
-- because a municipality can genuinely contain two people with the same name
-- and birthdate, the guard trigger runs first and is allowed to append a
-- discriminator (#2, #3, ...) when an AUTHORISED user explicitly declared the
-- record to be a different person. In that case the pair is also queued into
-- duplicate_cases so that a supervisor can still review it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Actor resolution (works with Supabase JWT *and* with the local backend,
-- which sets the nmbr.actor GUC for the transaction)
-- ---------------------------------------------------------------------
create or replace function fn_auth_uid()
returns uuid language plpgsql stable as $$
declare v_uid uuid;
begin
  if to_regprocedure('auth.uid()') is not null then
    begin
      execute 'select auth.uid()' into v_uid;
      return v_uid;
    exception when others then
      return null;
    end;
  end if;
  return null;
end $$;

create or replace function fn_current_actor()
returns users language plpgsql stable as $$
declare
  u users;
  guc text := nullif(current_setting('nmbr.actor', true), '');
  uid uuid := fn_auth_uid();
begin
  if guc is not null then
    select * into u from users where id = guc::uuid;
    if found then return u; end if;
  end if;
  if uid is not null then
    select * into u from users where auth_user_id = uid limit 1;
    if found then return u; end if;
  end if;
  return null;
end $$;

create or replace function fn_current_user_id()
returns uuid language sql stable as $$ select (fn_current_actor()).id $$;

create or replace function fn_current_role()
returns user_role language sql stable as $$
  select coalesce((fn_current_actor()).role, 'VIEWER'::user_role)
$$;

create or replace function fn_is_role(variadic p_roles text[])
returns boolean language sql stable as $$
  select coalesce((fn_current_actor()).role::text = any(p_roles), false)
     and coalesce((fn_current_actor()).active, false)
$$;

/** Raises a structured, client-friendly error when the actor lacks the role. */
create or replace function fn_require_role(variadic p_roles text[])
returns void language plpgsql stable as $$
declare r text := fn_current_role()::text; act users := fn_current_actor();
begin
  if act.id is null or not act.active then
    raise exception 'NMBR_UNAUTHENTICATED: Your session is not recognised. Please sign in again.'
      using errcode = 'P0002';
  end if;
  if not (r = any(p_roles)) then
    raise exception 'NMBR_FORBIDDEN: Your role (%) is not permitted to perform this action. Required: %.',
      r, array_to_string(p_roles, ' or ') using errcode = 'P0003';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Duplicate override flag (transaction scoped)
-- fn_create_person(name..., p_confirmed_distinct => true) sets this so that the
-- guard allows a *legitimate* namesake and records the reason in the audit log.
-- ---------------------------------------------------------------------
create or replace function fn_duplicate_override_active()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('nmbr.allow_identity_duplicate', true), ''), 'off') = 'on'
$$;

create or replace function fn_set_duplicate_override(p_on boolean)
returns void language plpgsql as $$
begin
  perform set_config('nmbr.allow_identity_duplicate', case when p_on then 'on' else 'off' end, true);
end $$;

-- ---------------------------------------------------------------------
-- Guard: identity keys, normalised columns and hard duplicate prevention
-- ---------------------------------------------------------------------
create or replace function fn_persons_before_write()
returns trigger language plpgsql as $$
declare
  v_key text;
  v_existing persons;
  v_suffix int;
  v_actor users := fn_current_actor();
begin
  new.first_name  := nullif(btrim(coalesce(new.first_name,'')), '');
  new.middle_name := nullif(btrim(coalesce(new.middle_name,'')), '');
  new.last_name   := nullif(btrim(coalesce(new.last_name,'')), '');
  new.suffix      := nullif(btrim(coalesce(new.suffix,'')), '');

  if new.first_name is null or new.last_name is null then
    raise exception 'NMBR_VALIDATION: First name and last name are required.' using errcode = 'P0004';
  end if;

  -- normalised search columns
  new.name_search    := fn_norm_text(concat_ws(' ', new.first_name, new.middle_name, new.last_name, new.suffix));
  new.last_search    := fn_norm_name(new.last_name);
  new.first_search   := fn_norm_name(new.first_name);
  new.contact_search := fn_norm_contact(new.contact_number);
  new.phonetic_key   := fn_phonetic(new.last_name) || '|' || fn_phonetic(new.first_name);
  new.updated_at     := now();

  if new.status = 'ARCHIVED' and new.archived_at is null then
    new.archived_at := now();
  end if;
  if new.status <> 'ARCHIVED' then
    new.archived_at := null;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, v_actor.id);
  end if;
  new.updated_by := coalesce(v_actor.id, new.updated_by);

  -- identity key maintenance
  if new.identity_lock then
    v_key := fn_identity_key(new.first_name, new.middle_name, new.last_name, new.suffix, new.date_of_birth);

    -- keep an existing discriminator when the key body has not changed
    if tg_op = 'UPDATE'
       and old.identity_key is not null
       and split_part(old.identity_key, '#', 1) = v_key
       and position('#' in old.identity_key) > 0 then
      new.identity_key := old.identity_key;
    else
      new.identity_key := v_key;
    end if;

    if new.status <> 'ARCHIVED' and new.merged_into is null and v_key <> '' then
      select * into v_existing from persons
        where identity_key = v_key
          and id <> new.id
          and status <> 'ARCHIVED'
          and merged_into is null
        limit 1;

      if found then
        if fn_duplicate_override_active() then
          -- authorised namesake: keep uniqueness with a discriminator
          select count(*) into v_suffix from persons
            where split_part(identity_key, '#', 1) = v_key;
          new.identity_key := v_key || '#' || greatest(v_suffix, 1);
          if new.status = 'ACTIVE' then
            new.status := 'FOR_REVIEW';
          end if;
          -- queue the namesake pair for a supervisor; the actual INSERT into
          -- duplicate_cases happens AFTER this row exists (FK requirement)
          perform set_config('nmbr.pending_namesake', v_existing.id::text, true);
        else
          raise exception using
            errcode = 'P0005',
            message = 'NMBR_DUPLICATE: An existing master record already matches this identity.',
            detail = jsonb_build_object(
              'code', 'IDENTITY_CONFLICT',
              'existing_person_id', v_existing.id,
              'existing_reference_no', v_existing.reference_no,
              'existing_name', concat_ws(' ', v_existing.first_name, v_existing.middle_name, v_existing.last_name),
              'existing_barangay_id', v_existing.barangay_id,
              'identity_key', v_key
            )::text,
            hint = 'Use the existing record, or declare this as a different person and let a supervisor review it.';
        end if;
      end if;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_persons_before_write on persons;
create trigger trg_persons_before_write
  before insert or update on persons
  for each row execute function fn_persons_before_write();


-- ---------------------------------------------------------------------
-- After-insert bookkeeping: an accepted "different person with an identical
-- identity key" is queued for supervisor review (never silently allowed).
-- ---------------------------------------------------------------------
create or replace function fn_persons_after_insert()
returns trigger language plpgsql as $$
declare
  v_pending text := nullif(current_setting('nmbr.pending_namesake', true), '');
  v_actor users := fn_current_actor();
  v_existing persons;
begin
  if v_pending is not null then
    select * into v_existing from persons where id = v_pending::uuid;
    if v_existing.id is not null then
      insert into duplicate_cases (person_id_a, person_id_b, match_score, match_band,
                                   matching_fields, matched_details, status, source,
                                   notes, created_by)
      values (v_existing.id, new.id, 100, 'VERY_LIKELY',
              array['last_name','first_name','middle_name','date_of_birth'],
              jsonb_build_object(
                'reason', 'Identity key collision accepted as a different person by ' ||
                          coalesce(v_actor.name, 'system'),
                'identity_key', new.identity_key),
              'PENDING', 'LIVE_CHECK',
              'Automatically queued: identical identity key accepted with an explicit override. Verify that these are genuinely two different residents.',
              v_actor.id)
      on conflict do nothing;
    end if;
    perform set_config('nmbr.pending_namesake', '', true);
  end if;
  return new;
end $$;

drop trigger if exists trg_persons_after_insert on persons;
create trigger trg_persons_after_insert
  after insert on persons
  for each row execute function fn_persons_after_insert();

-- ---------------------------------------------------------------------
-- Generic audit trail on the master registry (append only)
-- ---------------------------------------------------------------------
create or replace function fn_persons_audit()
returns trigger language plpgsql as $$
declare
  actor users := fn_current_actor();
  changed text[] := '{}';
  old_j jsonb;
  new_j jsonb;
  label text;
begin
  if coalesce(current_setting('nmbr.audit_silent', true), 'off') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id,
                            entity_label, old_values, new_values, changed_fields, session_info)
    values (actor.id, actor.name, actor.role, 'CREATED', 'PERSONS', new.id,
            concat_ws(' ', new.first_name, new.last_name), null, to_jsonb(new),
            array['record'], fn_session_info());
    return new;
  end if;

  old_j := to_jsonb(old);
  new_j := to_jsonb(new);
  select array_agg(k) into changed from (
    select key as k from jsonb_each(new_j) n
    where key not in ('updated_at','updated_by','name_search','last_search','first_search',
                      'contact_search','phonetic_key','identity_key','id','created_at','created_by')
      and n.value is distinct from old_j->key
  ) s;
  changed := coalesce(changed, '{}');

  if array_length(changed, 1) is null then
    return new;
  end if;

  label := concat_ws(' ', new.first_name, new.last_name);
  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id,
                          entity_label, old_values, new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role, 'UPDATED', 'PERSONS', new.id, label,
          (select jsonb_object_agg(k, old_j->k) from unnest(changed) k),
          (select jsonb_object_agg(k, new_j->k) from unnest(changed) k),
          changed,
          nullif(current_setting('nmbr.audit_reason', true), ''),
          fn_session_info());
  return new;
end $$;

drop trigger if exists trg_persons_audit on persons;
create trigger trg_persons_audit
  after insert or update on persons
  for each row execute function fn_persons_audit();

create or replace function fn_session_info()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'user_agent', nullif(current_setting('nmbr.user_agent', true), ''),
    'device', nullif(current_setting('nmbr.device', true), ''),
    'session_id', nullif(current_setting('nmbr.session_id', true), ''),
    'app', 'NMBR',
    'at', now())
$$;

-- ---------------------------------------------------------------------
-- Immutable audit log — nothing may rewrite history
-- ---------------------------------------------------------------------
create or replace function fn_audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'NMBR_AUDIT_IMMUTABLE: Audit log entries cannot be modified or deleted.'
    using errcode = 'P0006';
end $$;

drop trigger if exists trg_audit_immutable on audit_logs;
create trigger trg_audit_immutable
  before update or delete on audit_logs
  for each row execute function fn_audit_immutable();

-- ---------------------------------------------------------------------
-- Barangay history keeps the person's current barangay in sync.
-- One open (effective_to is null) row per person is the source of truth.
-- ---------------------------------------------------------------------
create or replace function fn_barangay_history_sync()
returns trigger language plpgsql as $$
declare
  rec member_barangay_history;
begin
  rec := coalesce(new, old);

  if tg_op = 'DELETE' then
    update persons set barangay_id = (
      select barangay_id from member_barangay_history
       where person_id = rec.person_id and effective_to is null
       order by effective_from desc limit 1)
     where id = rec.person_id;
    return rec;
  end if;

  if new.effective_to is null then
    -- close any other open row for this person
    update member_barangay_history
       set effective_to = coalesce(new.effective_from, current_date) - 1,
           status = 'ENDED'
     where person_id = new.person_id
       and id <> new.id
       and effective_to is null;

    update persons set barangay_id = new.barangay_id
     where id = new.person_id and barangay_id is distinct from new.barangay_id;
  end if;

  return new;
end $$;

drop trigger if exists trg_barangay_history_sync on member_barangay_history;
create trigger trg_barangay_history_sync
  after insert or update or delete on member_barangay_history
  for each row execute function fn_barangay_history_sync();

-- ---------------------------------------------------------------------
-- Import row / duplicate case bookkeeping
-- ---------------------------------------------------------------------
create or replace function fn_duplicate_cases_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status <> 'PENDING' and new.reviewed_at is null then
    new.reviewed_at := now();
    new.reviewed_by := coalesce(new.reviewed_by, fn_current_user_id());
  end if;
  return new;
end $$;

drop trigger if exists trg_duplicate_cases_touch on duplicate_cases;
create trigger trg_duplicate_cases_touch
  before update on duplicate_cases
  for each row execute function fn_duplicate_cases_touch();


-- #####################################################################
-- # 0004_rpc_registry.sql
-- #####################################################################

-- =====================================================================
-- NMBR — 0004_rpc_registry.sql
-- Server-side API surface for the master registry.
--
-- Every write goes through these SECURITY DEFINER functions. The browser can
-- never INSERT/UPDATE a person directly, so authorisation is always enforced
-- server-side (requirement 19) and every mutation is audited (requirement 15).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------
create or replace function fn_person_json(p persons)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', p.id,
    'reference_no', p.reference_no,
    'first_name', p.first_name,
    'middle_name', p.middle_name,
    'last_name', p.last_name,
    'suffix', p.suffix,
    'date_of_birth', p.date_of_birth,
    'sex', p.sex,
    'civil_status', p.civil_status,
    'contact_number', p.contact_number,
    'address', p.address,
    'purok', p.purok,
    'barangay_id', p.barangay_id,
    'barangay_name', fn_person_barangay_name(p),
    'status', p.status,
    'remarks', p.remarks,
    'household_id', p.household_id,
    'merged_into', p.merged_into,
    'created_at', p.created_at,
    'updated_at', p.updated_at,
    'created_by', p.created_by,
    'created_by_name', (select u.name from users u where u.id = p.created_by),
    'updated_by', p.updated_by,
    'updated_by_name', (select u.name from users u where u.id = p.updated_by),
    'open_duplicates', (select count(*) from duplicate_cases d
                         where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id))
  )
$$;

create or replace function fn_person_index_json(p persons)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', p.id, 'reference_no', p.reference_no,
    'first_name', p.first_name, 'middle_name', p.middle_name, 'last_name', p.last_name,
    'suffix', p.suffix, 'date_of_birth', p.date_of_birth, 'sex', p.sex,
    'purok', p.purok, 'address', p.address, 'contact_number', p.contact_number,
    'barangay_id', p.barangay_id, 'barangay_name', fn_person_barangay_name(p),
    'status', p.status, 'updated_at', p.updated_at,
    'identity_key', case when position('#' in p.identity_key) > 0 then null else p.identity_key end
  )
$$;

-- ---------------------------------------------------------------------
-- SEARCH  (requirement 17) — never returns the whole database at once
-- ---------------------------------------------------------------------
create or replace function fn_search_persons(
  p_query text default '',
  p_barangay_id uuid default null,
  p_status text default null,
  p_sex text default null,
  p_purok text default null,
  p_duplicates_only boolean default false,
  p_for_review_only boolean default false,
  p_attention_only boolean default false,
  p_sort text default 'name',
  p_dir text default 'asc',
  p_limit int default 25,
  p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q text := btrim(coalesce(p_query, ''));
  qn text := fn_norm_text(q);
  qd text := fn_norm_digits(q);
  qdate date := fn_norm_date(q);
  rows_json jsonb;
  total bigint;
  lim int := least(greatest(coalesce(p_limit, 25), 1), 200);
  off int := greatest(coalesce(p_offset, 0), 0);
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');

  with filtered as (
    select p.*
    from persons p
    where (p_barangay_id is null or p.barangay_id = p_barangay_id)
      and (p_status is null or p.status::text = p_status)
      and (p_sex is null or p.sex = p_sex)
      and (p_purok is null or fn_norm_text(p.purok) = fn_norm_text(p_purok))
      and (p.status <> 'ARCHIVED' or p_status = 'ARCHIVED')
      and (not p_duplicates_only or exists (
            select 1 from duplicate_cases d
             where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (not p_for_review_only or p.status = 'FOR_REVIEW')
      and (not p_attention_only or p.date_of_birth is null or p.sex is null or p.barangay_id is null
           or p.address is null or p.purok is null
           or (p.contact_search <> '' and length(p.contact_search) < 7)
           or exists (select 1 from duplicate_cases d
                       where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (
        q = '' or
        (qn <> '' and p.name_search like '%' || qn || '%') or
        (qn <> '' and fn_similarity(p.name_search, qn) >= 0.45) or
        (qd <> '' and length(qd) >= 6 and p.contact_search = fn_norm_contact(qd)) or
        (qd <> '' and p.reference_no ilike '%' || qd || '%') or
        (qdate is not null and p.date_of_birth = qdate) or
        (qn <> '' and fn_norm_text(fn_person_barangay_name(p)) like '%' || qn || '%') or
        (qn <> '' and fn_norm_text(p.purok) like '%' || qn || '%')
      )
  )
  select count(*) into total from filtered;

  with filtered as (
    select p.* from persons p
    where (p_barangay_id is null or p.barangay_id = p_barangay_id)
      and (p_status is null or p.status::text = p_status)
      and (p_sex is null or p.sex = p_sex)
      and (p_purok is null or fn_norm_text(p.purok) = fn_norm_text(p_purok))
      and (p.status <> 'ARCHIVED' or p_status = 'ARCHIVED')
      and (not p_duplicates_only or exists (
            select 1 from duplicate_cases d
             where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (not p_for_review_only or p.status = 'FOR_REVIEW')
      and (not p_attention_only or p.date_of_birth is null or p.sex is null or p.barangay_id is null
           or p.address is null or p.purok is null
           or (p.contact_search <> '' and length(p.contact_search) < 7)
           or exists (select 1 from duplicate_cases d
                       where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (
        q = '' or
        (qn <> '' and p.name_search like '%' || qn || '%') or
        (qn <> '' and fn_similarity(p.name_search, qn) >= 0.45) or
        (qd <> '' and length(qd) >= 6 and p.contact_search = fn_norm_contact(qd)) or
        (qd <> '' and p.reference_no ilike '%' || qd || '%') or
        (qdate is not null and p.date_of_birth = qdate) or
        (qn <> '' and fn_norm_text(fn_person_barangay_name(p)) like '%' || qn || '%') or
        (qn <> '' and fn_norm_text(p.purok) like '%' || qn || '%')
      )
    order by
      case when p_dir = 'asc' then
        case p_sort when 'updated' then null when 'barangay' then null else p.last_search end
      end asc nulls last,
      case when p_sort = 'updated' and p_dir = 'asc' then p.updated_at end asc,
      case when p_sort = 'updated' and p_dir = 'desc' then p.updated_at end desc,
      case when p_sort = 'barangay' and p_dir = 'asc' then fn_person_barangay_name(p) end asc,
      case when p_sort = 'barangay' and p_dir = 'desc' then fn_person_barangay_name(p) end desc,
      case when p_sort = 'name' and p_dir = 'desc' then p.last_search end desc,
      case when p_sort = 'dob' and p_dir = 'asc' then p.date_of_birth end asc nulls last,
      case when p_sort = 'dob' and p_dir = 'desc' then p.date_of_birth end desc nulls last,
      p.first_search asc, p.created_at desc
    limit lim offset off
  )
  select coalesce(jsonb_agg(fn_person_json(f)), '[]'::jsonb) into rows_json from filtered f;

  return jsonb_build_object('total', coalesce(total,0), 'rows', rows_json, 'limit', lim, 'offset', off);
end $$;

-- ---------------------------------------------------------------------
-- Offline cache bootstrap: compact index of every live record
-- ---------------------------------------------------------------------
create or replace function fn_person_index(p_barangay_id uuid default null, p_limit int default 20000)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows_json jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select coalesce(jsonb_agg(fn_person_index_json(p)), '[]'::jsonb) into rows_json
  from (
    select * from persons p
     where p.status <> 'ARCHIVED' and p.merged_into is null
       and (p_barangay_id is null or p.barangay_id = p_barangay_id)
     order by p.updated_at desc
     limit least(greatest(coalesce(p_limit, 20000), 1), 50000)
  ) p;
  return jsonb_build_object('rows', rows_json, 'generated_at', now());
end $$;

-- ---------------------------------------------------------------------
-- LIVE DUPLICATE CHECK (requirements 5, 6, 22)
-- ---------------------------------------------------------------------
create or replace function fn_check_person_duplicates(
  p jsonb,
  p_limit int default 10,
  p_exclude_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_key text := fn_identity_key(p->>'first_name', p->>'middle_name', p->>'last_name', p->>'suffix',
                                fn_norm_date(p->>'date_of_birth'));
  v_last text := fn_norm_name(p->>'last_name');
  v_first text := fn_norm_name(p->>'first_name');
  v_contact text := fn_norm_contact(p->>'contact_number');
  v_phon text := fn_phonetic(p->>'last_name') || '|' || fn_phonetic(p->>'first_name');
  v_first_two text := left(v_last, 2);
  results jsonb := '[]'::jsonb;
  r persons;
  sc jsonb;
  thresholds jsonb := fn_duplicate_thresholds();
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');

  for r in
    select p2.*
    from persons p2
    where p2.status <> 'ARCHIVED'
      and p2.merged_into is null
      and (p_exclude_id is null or p2.id <> p_exclude_id)
      and (
        (v_key <> '' and p2.identity_key = v_key)
        or (v_contact <> '' and p2.contact_search = v_contact and length(v_contact) >= 7)
        or (v_last <> '' and left(p2.last_search, 2) = v_first_two)
        or (v_phon <> '|' and p2.phonetic_key = v_phon)
        or (v_last <> '' and fn_similarity(p2.last_search, v_last) >= 0.5)
      )
    limit 400
  loop
    sc := fn_score_pair(p, r);
    if (sc->>'score')::numeric >= greatest((thresholds->>'notice')::numeric - 25, 0) then
      results := results || jsonb_build_array(
        jsonb_build_object(
          'person', fn_person_index_json(r),
          'person_detail', fn_person_json(r),
          'score', (sc->>'score')::numeric,
          'band', sc->>'band',
          'reasons', sc->'reasons',
          'matched_fields', sc->'matched_fields',
          'flags', sc->'flags'
        ));
    end if;
  end loop;

  select coalesce(jsonb_agg(t.e order by (t.e->>'score')::numeric desc), '[]'::jsonb)
    into results
    from (select e from jsonb_array_elements(results) e
           order by (e->>'score')::numeric desc
           limit least(greatest(coalesce(p_limit,10),1), 50)) t;

  return results;
end $$;

-- ---------------------------------------------------------------------
-- CREATE PERSON (requirements 5, 7, 8, 22)
-- Raises NMBR_DUPLICATE (SQLSTATE P0005) when the identity guard trips, and
-- returns a structured response so the UI can offer "use existing record".
-- ---------------------------------------------------------------------
create or replace function fn_create_person(
  p jsonb,
  p_confirmed_distinct boolean default false,
  p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_id uuid;
  v_new persons;
  v_dup jsonb;
  v_client_ref uuid := nullif(p->>'client_ref','')::uuid;
  v_band text;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN');

  -- offline sync replay must be idempotent
  if v_client_ref is not null then
    select * into v_new from persons where client_ref = v_client_ref;
    if found then
      return jsonb_build_object('ok', true, 'replayed', true, 'person', fn_person_json(v_new));
    end if;
  end if;

  -- server-side validation (never trust the browser)
  if coalesce(btrim(p->>'first_name'),'') = '' or coalesce(btrim(p->>'last_name'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'First name and last name are required.',
                              'code', 'VALIDATION');
  end if;
  if (p->>'date_of_birth') is not null and fn_norm_date(p->>'date_of_birth') is null then
    return jsonb_build_object('ok', false, 'error', 'Date of birth is not a valid date.', 'code', 'VALIDATION');
  end if;
  if coalesce(p->>'sex','') not in ('', 'MALE', 'FEMALE') then
    return jsonb_build_object('ok', false, 'error', 'Sex must be MALE or FEMALE.', 'code', 'VALIDATION');
  end if;

  v_dup := fn_check_person_duplicates(p, 5, null);
  v_band := coalesce(v_dup->0->>'band', 'DISTINCT');

  if not p_confirmed_distinct and v_band = 'VERY_LIKELY'
     and coalesce((fn_setting('system','{}'::jsonb)->>'block_on_very_likely')::boolean, true) then
    return jsonb_build_object(
      'ok', false, 'code', 'DUPLICATE_REVIEW_REQUIRED',
      'band', v_band, 'matches', v_dup,
      'error', 'Very likely duplicate. Review the existing record before continuing.');
  end if;

  if p_confirmed_distinct then
    perform fn_set_duplicate_override(true);
    perform set_config('nmbr.audit_reason', coalesce(p_reason, 'Declared as a different person after duplicate review'), true);
  end if;

  insert into persons (
    first_name, middle_name, last_name, suffix, date_of_birth, sex, civil_status,
    contact_number, address, purok, barangay_id, status, remarks, household_id,
    client_ref, created_by, updated_by)
  values (
    p->>'first_name', nullif(p->>'middle_name',''), p->>'last_name', nullif(p->>'suffix',''),
    fn_norm_date(p->>'date_of_birth'), nullif(p->>'sex',''), nullif(p->>'civil_status',''),
    nullif(p->>'contact_number',''), nullif(p->>'address',''), nullif(p->>'purok',''),
    nullif(p->>'barangay_id','')::uuid,
    coalesce(nullif(p->>'status',''), 'ACTIVE')::person_status,
    nullif(p->>'remarks',''), nullif(p->>'household_id','')::uuid,
    v_client_ref, actor.id, actor.id)
  returning * into v_new;

  -- start barangay history
  if v_new.barangay_id is not null then
    insert into member_barangay_history (person_id, barangay_id, effective_from, status, reason, created_by)
    values (v_new.id, v_new.barangay_id, current_date, 'ACTIVE', 'RESIDENT_TRANSFER', actor.id);
  end if;

  perform fn_set_duplicate_override(false);

  -- queue near-miss matches for review so nothing is lost
  if v_band in ('POSSIBLE','POTENTIAL') then
    declare m jsonb;
    begin
      for m in select * from jsonb_array_elements(v_dup) loop
        if (m->>'score')::numeric >= (fn_duplicate_thresholds()->>'warn')::numeric then
          insert into duplicate_cases (person_id_a, person_id_b, match_score, match_band,
                                       matching_fields, matched_details, status, source, created_by)
          values ((m->'person'->>'id')::uuid, v_new.id, (m->>'score')::numeric,
                  (m->>'band')::match_band,
                  array(select jsonb_array_elements_text(m->'matched_fields')),
                  m, 'PENDING', 'LIVE_CHECK', actor.id)
          on conflict do nothing;
        end if;
      end loop;
    end;
  end if;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role, 'CREATED', 'PERSONS', v_new.id,
          concat_ws(' ', v_new.first_name, v_new.last_name), fn_person_json(v_new), array['record'],
          p_reason, fn_session_info());

  return jsonb_build_object('ok', true, 'person', fn_person_json(v_new),
                            'matches', v_dup, 'band', v_band);
end $$;

-- ---------------------------------------------------------------------
-- UPDATE PERSON (requirement 8 "use existing record" / 14 profile edit)
-- ---------------------------------------------------------------------
create or replace function fn_update_person(
  p_id uuid,
  p jsonb,
  p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_old persons;
  v_new persons;
  v_dup jsonb;
  v_band text;
  r text := fn_current_role()::text;
  identity_fields text[] := array['first_name','middle_name','last_name','suffix','date_of_birth','sex'];
  k text;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN');

  select * into v_old from persons where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Member record not found.');
  end if;
  if v_old.merged_into is not null then
    return jsonb_build_object('ok', false, 'code', 'MERGED',
      'error', 'This record was merged into another master record and can no longer be edited.');
  end if;

  -- Encoders may not rewrite core identity fields; they can correct contact,
  -- address, purok, civil status and remarks on records they maintain.
  if r = 'ENCODER' then
    foreach k in array identity_fields loop
      if p ? k and coalesce(nullif(p->>k,''), '') is distinct from coalesce(nullif(to_jsonb(v_old)->>k,''),'')
         and not (k = 'sex' and v_old.sex is null) then
        return jsonb_build_object('ok', false, 'code', 'FORBIDDEN_FIELD',
          'error', 'Encoders cannot change ' || replace(k,'_',' ') || '. Ask an administrator to correct identity fields.');
      end if;
    end loop;
  end if;

  if coalesce((fn_setting('system','{}'::jsonb)->>'require_reason_on_edit')::boolean, true)
     and coalesce(btrim(p_reason), '') = ''
     and (p ? 'date_of_birth' or p ? 'last_name' or p ? 'first_name' or p ? 'barangay_id') then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED',
      'error', 'A reason is required when changing identity fields.');
  end if;

  -- pre-flight duplicate check against the proposed values
  v_dup := fn_check_person_duplicates(
    jsonb_build_object(
      'first_name', coalesce(nullif(p->>'first_name',''), v_old.first_name),
      'middle_name', coalesce(nullif(p->>'middle_name',''), v_old.middle_name),
      'last_name', coalesce(nullif(p->>'last_name',''), v_old.last_name),
      'suffix', coalesce(nullif(p->>'suffix',''), v_old.suffix),
      'date_of_birth', coalesce(nullif(p->>'date_of_birth',''), v_old.date_of_birth::text),
      'sex', coalesce(nullif(p->>'sex',''), v_old.sex),
      'contact_number', coalesce(nullif(p->>'contact_number',''), v_old.contact_number),
      'purok', coalesce(nullif(p->>'purok',''), v_old.purok),
      'address', coalesce(nullif(p->>'address',''), v_old.address),
      'barangay_name', fn_person_barangay_name(v_old)),
    5, p_id);
  v_band := coalesce(v_dup->0->>'band', 'DISTINCT');
  if v_band = 'VERY_LIKELY' and r = 'ENCODER' then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_REVIEW_REQUIRED', 'band', v_band,
      'matches', v_dup,
      'error', 'These changes would make the record a very likely duplicate of another member. Submit for review.');
  end if;

  perform set_config('nmbr.audit_reason', coalesce(p_reason, ''), true);

  update persons set
    first_name     = coalesce(nullif(p->>'first_name',''), first_name),
    middle_name    = case when p ? 'middle_name' then nullif(p->>'middle_name','') else middle_name end,
    last_name      = coalesce(nullif(p->>'last_name',''), last_name),
    suffix         = case when p ? 'suffix' then nullif(p->>'suffix','') else suffix end,
    date_of_birth  = case when p ? 'date_of_birth' then fn_norm_date(p->>'date_of_birth') else date_of_birth end,
    sex            = case when p ? 'sex' then nullif(p->>'sex','') else sex end,
    civil_status   = case when p ? 'civil_status' then nullif(p->>'civil_status','') else civil_status end,
    contact_number = case when p ? 'contact_number' then nullif(p->>'contact_number','') else contact_number end,
    address        = case when p ? 'address' then nullif(p->>'address','') else address end,
    purok          = case when p ? 'purok' then nullif(p->>'purok','') else purok end,
    remarks        = case when p ? 'remarks' then nullif(p->>'remarks','') else remarks end,
    status         = case when p ? 'status' then (p->>'status')::person_status else status end,
    updated_by     = actor.id
  where id = p_id
  returning * into v_new;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          old_values, new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role, 'UPDATED', 'PERSONS', v_new.id,
          concat_ws(' ', v_new.first_name, v_new.last_name),
          to_jsonb(v_old), to_jsonb(v_new), array(select jsonb_object_keys(p)), p_reason, fn_session_info());

  return jsonb_build_object('ok', true, 'person', fn_person_json(v_new), 'matches', v_dup);
end $$;

-- ---------------------------------------------------------------------
-- BARANGAY TRANSFER / HISTORY (requirement 9)
-- ---------------------------------------------------------------------
create or replace function fn_transfer_barangay(
  p_person_id uuid,
  p_barangay_id uuid,
  p_reason transfer_reason default 'RESIDENT_TRANSFER',
  p_effective_date date default current_date,
  p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_person persons;
  v_old_brgy uuid;
  v_new_brgy text;
  v_old_brgy_name text;
  eff date := coalesce(p_effective_date, current_date);
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');

  select * into v_person from persons where id = p_person_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Member record not found.');
  end if;
  if v_person.merged_into is not null then
    return jsonb_build_object('ok', false, 'code', 'MERGED', 'error', 'This record was merged and is read-only.');
  end if;

  v_old_brgy := v_person.barangay_id;
  v_old_brgy_name := fn_person_barangay_name(v_person);
  select name into v_new_brgy from barangays where id = p_barangay_id;
  if v_new_brgy is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION', 'error', 'Barangay not found.');
  end if;
  if v_old_brgy = p_barangay_id then
    return jsonb_build_object('ok', false, 'code', 'NO_CHANGE',
      'error', 'The member is already assigned to ' || v_new_brgy || '.');
  end if;

  perform set_config('nmbr.audit_reason', coalesce(p_notes, p_reason::text), true);

  -- close the currently open residency. When the transfer is backdated before
  -- the stored start date the earlier row is collapsed rather than inverted.
  update member_barangay_history
     set effective_from = least(effective_from, greatest(eff - 1, date '1901-01-01')),
         effective_to = greatest(eff - 1, date '1901-01-01'),
         status = 'ENDED',
         notes = trim(both ' |' from concat_ws(' | ', notes,
                 'Closed automatically on transfer to ' || v_new_brgy))
   where person_id = p_person_id and effective_to is null;

  -- open the new residency (triggers keep persons.barangay_id in sync)
  insert into member_barangay_history (person_id, barangay_id, effective_from, effective_to,
                                       status, reason, notes, created_by)
  values (p_person_id, p_barangay_id, eff, null, 'ACTIVE', p_reason, p_notes, actor.id);

  update persons set barangay_id = p_barangay_id, updated_by = actor.id where id = p_person_id;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          old_values, new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role, 'TRANSFERRED', 'PERSONS', p_person_id,
          concat_ws(' ', v_person.first_name, v_person.last_name),
          jsonb_build_object('barangay_id', v_old_brgy, 'barangay_name', v_old_brgy_name),
          jsonb_build_object('barangay_id', p_barangay_id, 'barangay_name', v_new_brgy,
                             'effective_from', eff),
          array['barangay_id'],
          coalesce(p_notes, 'Barangay transfer: ' || coalesce(v_old_brgy_name,'—') || ' → ' || v_new_brgy
                   || ' (' || p_reason::text || ')'),
          fn_session_info());

  return jsonb_build_object('ok', true, 'message',
    'Transferred to ' || v_new_brgy || '. One master record retained with full barangay history.');
end $$;

create or replace function fn_person_history(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows_json jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select coalesce(jsonb_agg(x order by x->>'effective_from' desc), '[]'::jsonb) into rows_json from (
    select jsonb_build_object(
             'id', h.id, 'person_id', h.person_id, 'barangay_id', h.barangay_id,
             'barangay_name', b.name, 'effective_from', h.effective_from,
             'effective_to', h.effective_to, 'status', h.status,
             'reason', h.reason, 'notes', h.notes, 'created_at', h.created_at,
             'created_by_name', (select u.name from users u where u.id = h.created_by)) as x
    from member_barangay_history h join barangays b on b.id = h.barangay_id
    where h.person_id = p_person_id) s;
  return rows_json;
end $$;

create or replace function fn_person_detail(p_person_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_person persons;
  v_json jsonb;
  v_history jsonb;
  v_household jsonb;
  v_duplicates jsonb;
  v_audit jsonb;
  v_merged jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select * into v_person from persons where id = p_person_id;
  if not found then return null; end if;

  v_history := fn_person_history(p_person_id);

  select jsonb_build_object(
           'id', h.id,
           'household_no', h.household_no,
           'address', h.address,
           'purok', h.purok,
           'barangay_id', h.barangay_id,
           'barangay_name', (select b.name from barangays b where b.id = h.barangay_id),
           'head_person_id', h.head_person_id,
           'head_name', (select concat_ws(' ', p2.first_name, p2.last_name) from persons p2 where p2.id = h.head_person_id),
           'member_count', (select count(*) from persons p3 where p3.household_id = h.id and p3.merged_into is null))
    into v_household
    from households h where h.id = v_person.household_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id,
           'status', d.status,
           'match_score', d.match_score,
           'match_band', d.match_band,
           'matching_fields', d.matching_fields,
           'matched_details', d.matched_details,
           'created_at', d.created_at,
           'resolution', d.resolution,
           'notes', d.notes,
           'reviewed_by_name', d.reviewed_by_name,
           'reviewed_at', d.reviewed_at,
           'other_person', fn_person_index_json(o)) order by d.match_score desc), '[]'::jsonb)
    into v_duplicates
    from duplicate_cases d
    join persons o on o.id = case when d.person_id_a = p_person_id then d.person_id_b else d.person_id_a end
   where d.person_id_a = p_person_id or d.person_id_b = p_person_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'action', a.action, 'user_name', a.user_name, 'timestamp', a.timestamp,
           'old_values', a.old_values, 'new_values', a.new_values,
           'changed_fields', a.changed_fields, 'reason', a.reason) order by a.timestamp desc), '[]'::jsonb)
    into v_audit
    from (select * from audit_logs
           where entity_type = 'PERSONS' and entity_id = p_person_id
           order by timestamp desc
           limit 100) a;

  select coalesce(jsonb_agg(fn_person_index_json(m)), '[]'::jsonb)
    into v_merged
    from persons m where m.merged_into = p_person_id;

  v_json := fn_person_json(v_person) || jsonb_build_object(
    'history', v_history,
    'household', v_household,
    'duplicates', v_duplicates,
    'audit', v_audit,
    'merged_from', v_merged);

  return v_json;
end $$;

-- ---------------------------------------------------------------------
-- STATUS CHANGE — soft delete / archive / restore (requirement 24)
-- ---------------------------------------------------------------------
create or replace function fn_set_person_status(
  p_person_id uuid,
  p_status text,
  p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_old persons;
  v_new persons;
  v_status person_status;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');

  v_status := p_status::person_status;
  select * into v_old from persons where id = p_person_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Member record not found.');
  end if;
  if v_status = 'ARCHIVED' and coalesce(btrim(p_reason),'') = '' then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED',
      'error', 'A reason is required to archive a member record.');
  end if;

  -- restoring must not re-introduce a duplicate key
  if v_old.status = 'ARCHIVED' and v_status <> 'ARCHIVED' then
    update persons
       set status = v_status, merged_into = null, identity_lock = true, updated_by = actor.id
     where id = p_person_id
     returning * into v_new;
  else
    update persons set status = v_status, updated_by = actor.id
     where id = p_person_id
     returning * into v_new;
  end if;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          old_values, new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role,
          case when v_status = 'ARCHIVED' then 'ARCHIVED'
               when v_old.status = 'ARCHIVED' then 'RESTORED'
               else 'STATUS_CHANGED' end,
          'PERSONS', p_person_id, concat_ws(' ', v_new.first_name, v_new.last_name),
          jsonb_build_object('status', v_old.status), jsonb_build_object('status', v_new.status),
          array['status'], p_reason, fn_session_info());

  return jsonb_build_object('ok', true, 'person', fn_person_json(v_new));
end $$;


-- #####################################################################
-- # 0005_rpc_duplicates.sql
-- #####################################################################

-- =====================================================================
-- NMBR — 0005_rpc_duplicates.sql
-- Duplicate Review Centre, merge workflow and barangay helpers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Duplicate case list (requirement 10)
-- ---------------------------------------------------------------------
create or replace function fn_list_duplicate_cases(
  p_status text default 'PENDING',
  p_barangay_id uuid default null,
  p_min_score numeric default null,
  p_query text default '',
  p_limit int default 25,
  p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  rows_json jsonb;
  total bigint;
  qn text := fn_norm_text(p_query);
  lim int := least(greatest(coalesce(p_limit,25),1), 200);
  off int := greatest(coalesce(p_offset,0),0);
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');

  with base as (
    select d.*, a.first_name as a_first, a.last_name as a_last, b.first_name as b_first, b.last_name as b_last,
           a.name_search as a_name, b.name_search as b_name
    from duplicate_cases d
    join persons a on a.id = d.person_id_a
    join persons b on b.id = d.person_id_b
    where (p_status is null or p_status = 'ALL' or d.status::text = p_status)
      and (p_min_score is null or d.match_score >= p_min_score)
      and (p_barangay_id is null or a.barangay_id = p_barangay_id or b.barangay_id = p_barangay_id)
      and (qn = '' or a.name_search like '%'||qn||'%' or b.name_search like '%'||qn||'%'
           or a.reference_no ilike '%'||p_query||'%' or b.reference_no ilike '%'||p_query||'%')
  )
  select count(*) into total from base;

  with base as (
    select d.*
    from duplicate_cases d
    join persons a on a.id = d.person_id_a
    join persons b on b.id = d.person_id_b
    where (p_status is null or p_status = 'ALL' or d.status::text = p_status)
      and (p_min_score is null or d.match_score >= p_min_score)
      and (p_barangay_id is null or a.barangay_id = p_barangay_id or b.barangay_id = p_barangay_id)
      and (qn = '' or a.name_search like '%'||qn||'%' or b.name_search like '%'||qn||'%'
           or a.reference_no ilike '%'||p_query||'%' or b.reference_no ilike '%'||p_query||'%')
    order by case when d.status = 'PENDING' then 0 else 1 end, d.match_score desc, d.created_at desc
    limit lim offset off
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id,
      'person_id_a', d.person_id_a,
      'person_id_b', d.person_id_b,
      'match_score', d.match_score,
      'match_band', d.match_band,
      'matching_fields', d.matching_fields,
      'matched_details', d.matched_details,
      'status', d.status,
      'source', d.source,
      'batch_id', d.batch_id,
      'resolution', d.resolution,
      'notes', d.notes,
      'reviewed_by', d.reviewed_by,
      'reviewed_by_name', d.reviewed_by_name,
      'reviewed_at', d.reviewed_at,
      'created_at', d.created_at,
      'person_a', fn_person_index_json(a),
      'person_b', fn_person_index_json(b)
    ) order by case when d.status = 'PENDING' then 0 else 1 end, d.match_score desc, d.created_at desc), '[]'::jsonb)
  into rows_json
  from base d
  join persons a on a.id = d.person_id_a
  join persons b on b.id = d.person_id_b;

  return jsonb_build_object('total', coalesce(total,0), 'rows', rows_json);
end $$;

-- ---------------------------------------------------------------------
-- Open (or refresh) a duplicate case. Encoders may flag; review is admin work.
-- ---------------------------------------------------------------------
create or replace function fn_open_duplicate_case(
  p_person_a uuid,
  p_person_b uuid,
  p_source text default 'MANUAL',
  p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  a persons; b persons; sc jsonb; v_id uuid; existing duplicate_cases;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN');
  if p_person_a = p_person_b then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION', 'error', 'A record cannot be compared with itself.');
  end if;
  select * into a from persons where id = p_person_a;
  select * into b from persons where id = p_person_b;
  if a.id is null or b.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'One of the records no longer exists.');
  end if;

  select * into existing from duplicate_cases
   where least(person_id_a, person_id_b) = least(p_person_a, p_person_b)
     and greatest(person_id_a, person_id_b) = greatest(p_person_a, p_person_b);

  if found then
    if existing.status <> 'PENDING' then
      update duplicate_cases set status = 'PENDING', notes = coalesce(p_notes, notes) where id = existing.id;
    end if;
    return jsonb_build_object('ok', true, 'case_id', existing.id, 'existing', true);
  end if;

  sc := fn_score_pair(fn_person_index_json(b) || jsonb_build_object('barangay_name', fn_person_barangay_name(b)), a);

  insert into duplicate_cases (person_id_a, person_id_b, match_score, match_band, matching_fields,
                               matched_details, status, source, notes, created_by)
  values (p_person_a, p_person_b, (sc->>'score')::numeric, (sc->>'band')::match_band,
          array(select jsonb_array_elements_text(coalesce(sc->'matched_fields','[]'::jsonb))),
          sc, 'PENDING', coalesce(p_source,'MANUAL'), p_notes, actor.id)
  returning id into v_id;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          new_values, reason, session_info)
  values (actor.id, actor.name, actor.role, 'DUPLICATE_FLAGGED', 'DUPLICATE_CASE', v_id,
          concat_ws(' vs ', concat_ws(' ', a.first_name, a.last_name), concat_ws(' ', b.first_name, b.last_name)),
          sc, p_notes, fn_session_info());

  return jsonb_build_object('ok', true, 'case_id', v_id, 'score', (sc->>'score')::numeric);
end $$;

-- ---------------------------------------------------------------------
-- Resolve a case without merging (different people / keep both / defer)
-- ---------------------------------------------------------------------
create or replace function fn_resolve_duplicate_case(
  p_case_id uuid,
  p_resolution text,
  p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  c duplicate_cases;
  v_status duplicate_status;
  a persons; b persons;
  v_reason text;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');

  select * into c from duplicate_cases where id = p_case_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'Duplicate case not found.');
  end if;

  v_status := case upper(coalesce(p_resolution,''))
                when 'DIFFERENT_PERSON' then 'DIFFERENT_PERSON'::duplicate_status
                when 'KEEP_BOTH' then 'KEPT_BOTH'::duplicate_status
                when 'DEFER' then 'DEFERRED'::duplicate_status
                when 'INVESTIGATE_LATER' then 'DEFERRED'::duplicate_status
                when 'DISMISS' then 'DISMISSED'::duplicate_status
                when 'MERGED' then 'MERGED'::duplicate_status
                else null end;
  if v_status is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION',
      'error', 'Resolution must be one of: DIFFERENT_PERSON, KEEP_BOTH, DEFER, DISMISS.');
  end if;
  if coalesce(btrim(p_notes),'') = '' then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED',
      'error', 'Please record why this resolution was chosen — it becomes part of the audit trail.');
  end if;

  update duplicate_cases
     set status = v_status, resolution = p_resolution, notes = p_notes,
         reviewed_by = actor.id, reviewed_by_name = actor.name, reviewed_at = now()
   where id = p_case_id;

  select * into a from persons where id = c.person_id_a;
  select * into b from persons where id = c.person_id_b;

  -- "different people" removes the FOR_REVIEW flag raised during creation
  if v_status in ('DIFFERENT_PERSON','KEPT_BOTH') then
    update persons set status = 'ACTIVE'
     where id in (c.person_id_a, c.person_id_b) and status = 'FOR_REVIEW';
  end if;

  v_reason := case v_status
    when 'DIFFERENT_PERSON' then 'Confirmed as two different people — ' || coalesce(p_notes,'')
    when 'KEPT_BOTH' then 'Both records retained intentionally — ' || coalesce(p_notes,'')
    when 'DEFERRED' then 'Investigation deferred — ' || coalesce(p_notes,'')
    else 'Case dismissed — ' || coalesce(p_notes,'') end;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          old_values, new_values, reason, session_info)
  values (actor.id, actor.name, actor.role, 'DUPLICATE_REVIEWED', 'DUPLICATE_CASE', p_case_id,
          concat_ws(' vs ', concat_ws(' ', a.first_name, a.last_name), concat_ws(' ', b.first_name, b.last_name)),
          jsonb_build_object('status','PENDING'), jsonb_build_object('status', v_status::text),
          v_reason, fn_session_info());

  return jsonb_build_object('ok', true, 'status', v_status::text);
end $$;

-- ---------------------------------------------------------------------
-- MERGE (requirement 11) — administrators only, never destructive.
-- The losing record is ARCHIVED and keeps a pointer to the survivor so that
-- history, audit and duplicate cases remain traceable forever.
-- ---------------------------------------------------------------------
create or replace function fn_merge_persons(
  p_keep_id uuid,
  p_merge_id uuid,
  p_resolved jsonb default '{}'::jsonb,
  p_reason text default null,
  p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  keep persons; loser persons; merged persons;
  changes jsonb := '{}'::jsonb;
  k text;
  v_value text;
  survivor_name text;
  loser_name text;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');

  if not coalesce(p_confirm, false) then
    return jsonb_build_object('ok', false, 'code', 'CONFIRM_REQUIRED',
      'error', 'Merging is irreversible from the user interface. Please re-confirm the merge.');
  end if;
  if p_keep_id = p_merge_id then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION', 'error', 'A record cannot be merged into itself.');
  end if;
  if coalesce(btrim(p_reason),'') = '' then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED',
      'error', 'A reason is required for the audit trail.');
  end if;

  select * into keep from persons where id = p_keep_id for update;
  select * into loser from persons where id = p_merge_id for update;
  if keep.id is null or loser.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'error', 'One of the records no longer exists.');
  end if;
  if loser.merged_into is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_MERGED',
      'error', 'That record has already been merged into another master record.');
  end if;
  if keep.merged_into is not null then
    return jsonb_build_object('ok', false, 'code', 'TARGET_MERGED',
      'error', 'The surviving record itself has been merged away. Choose the current master record.');
  end if;

  survivor_name := concat_ws(' ', keep.first_name, keep.last_name);
  loser_name := concat_ws(' ', loser.first_name, loser.last_name);

  perform set_config('nmbr.audit_silent', 'on', true);
  perform set_config('nmbr.audit_reason', p_reason, true);

  -- apply the administrator's field-by-field decisions; a blank value keeps the survivor's
  foreach k in array array['first_name','middle_name','last_name','suffix','date_of_birth','sex',
                           'civil_status','contact_number','address','purok','remarks'] loop
    if p_resolved ? k and coalesce(p_resolved->>k, '') <> '' then
      v_value := p_resolved->>k;
      if k = 'date_of_birth' then
        update persons set date_of_birth = fn_norm_date(v_value) where id = p_keep_id;
      else
        execute format('update persons set %I = $1 where id = $2', k) using v_value, p_keep_id;
      end if;
      changes := changes || jsonb_build_object(k, v_value);
    end if;
  end loop;

  -- carry over everything that is missing on the survivor
  update persons set
    middle_name    = coalesce(middle_name, loser.middle_name),
    suffix         = coalesce(suffix, loser.suffix),
    date_of_birth  = coalesce(date_of_birth, loser.date_of_birth),
    sex            = coalesce(sex, loser.sex),
    civil_status   = coalesce(civil_status, loser.civil_status),
    contact_number = coalesce(contact_number, loser.contact_number),
    address        = coalesce(address, loser.address),
    purok          = coalesce(purok, loser.purok),
    household_id   = coalesce(household_id, loser.household_id),
    remarks        = trim(both ' |' from concat_ws(' | ', remarks,
                        'Merged from ' || loser.reference_no || ' (' || loser_name || ')'))
  where id = p_keep_id;

  -- barangay history follows the survivor: the closed residencies are moved
  -- over (a person can only have ONE open residency, so it is closed first)
  update member_barangay_history
     set effective_to = coalesce(effective_to, current_date), status = 'ENDED'
   where person_id = p_merge_id and effective_to is null;

  update member_barangay_history h set person_id = p_keep_id
   where h.person_id = p_merge_id
     and not exists (select 1 from member_barangay_history h2
                      where h2.person_id = p_keep_id
                        and h2.barangay_id = h.barangay_id
                        and h2.effective_from = h.effective_from);

  update households set head_person_id = p_keep_id where head_person_id = p_merge_id;
  update import_rows set match_person_id = p_keep_id where match_person_id = p_merge_id;
  update import_rows set imported_person_id = p_keep_id where imported_person_id = p_merge_id;

  -- duplicate cases: re-point to the survivor where no case already exists for
  -- the resulting pair (the unique pair index forbids duplicates)
  update duplicate_cases d set person_id_a = p_keep_id
   where d.person_id_a = p_merge_id and d.person_id_b <> p_keep_id
     and not exists (select 1 from duplicate_cases d2
                      where d2.id <> d.id
                        and least(d2.person_id_a, d2.person_id_b) = least(p_keep_id, d.person_id_b)
                        and greatest(d2.person_id_a, d2.person_id_b) = greatest(p_keep_id, d.person_id_b));

  update duplicate_cases d set person_id_b = p_keep_id
   where d.person_id_b = p_merge_id and d.person_id_a <> p_keep_id
     and not exists (select 1 from duplicate_cases d2
                      where d2.id <> d.id
                        and least(d2.person_id_a, d2.person_id_b) = least(d.person_id_a, p_keep_id)
                        and greatest(d2.person_id_a, d2.person_id_b) = greatest(d.person_id_a, p_keep_id));

  -- any case that would have been a duplicate of an existing case is closed
  update duplicate_cases
     set status = 'DISMISSED',
         notes = trim(both ' |' from concat_ws(' | ', notes,
           'Closed automatically: the compared record was merged into ' || survivor_name))
   where status = 'PENDING' and (person_id_a = p_merge_id or person_id_b = p_merge_id);

  update duplicate_cases
     set status = 'MERGED', resolution = 'MERGED',
         notes = trim(both ' ' from concat_ws(' | ', notes, 'Merged by ' || actor.name || ': ' || p_reason)),
         reviewed_by = actor.id, reviewed_by_name = actor.name, reviewed_at = now()
   where (person_id_a = p_keep_id and person_id_b = p_merge_id)
      or (person_id_a = p_merge_id and person_id_b = p_keep_id);

  -- archive the losing record (never a hard delete)
  update persons set
    status = 'ARCHIVED',
    merged_into = p_keep_id,
    merged_at = now(),
    identity_lock = false,
    identity_key = identity_key,     -- retained for traceability; partial index excludes archived rows
    remarks = trim(both ' |' from concat_ws(' | ', remarks, 'Archived: merged into ' || keep.reference_no)),
    updated_by = actor.id
  where id = p_merge_id
  returning * into merged;

  perform set_config('nmbr.audit_silent', 'off', true);

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          old_values, new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role, 'MERGED', 'PERSONS', p_keep_id,
          survivor_name || ' ← ' || loser_name,
          jsonb_build_object('surviving_record', jsonb_build_object('id', keep.id, 'reference_no', keep.reference_no, 'name', survivor_name),
                             'merged_record', jsonb_build_object('id', loser.id, 'reference_no', loser.reference_no, 'name', loser_name),
                             'fields_before', to_jsonb(keep)),
          jsonb_build_object('surviving_record', jsonb_build_object('id', p_keep_id, 'reference_no', keep.reference_no),
                             'merged_record', jsonb_build_object('id', p_merge_id, 'reference_no', loser.reference_no),
                             'resolved_fields', changes,
                             'fields_retained_from_loser', jsonb_build_object(
                               'middle_name', loser.middle_name, 'date_of_birth', loser.date_of_birth,
                               'sex', loser.sex, 'contact_number', loser.contact_number,
                               'address', loser.address, 'purok', loser.purok)),
          array(select jsonb_object_keys(changes)),
          p_reason, fn_session_info());

  return jsonb_build_object('ok', true,
    'message', 'Merged ' || loser_name || ' into ' || survivor_name
               || '. The duplicate record was archived (not deleted) and the merge was logged.',
    'surviving_person_id', p_keep_id,
    'merged_person_id', p_merge_id,
    'resolved_fields', changes);
end $$;

-- ---------------------------------------------------------------------
-- Compare two records for the side-by-side review screen
-- ---------------------------------------------------------------------
create or replace function fn_compare_persons(p_a uuid, p_b uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a persons; b persons; sc jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select * into a from persons where id = p_a;
  select * into b from persons where id = p_b;
  if a.id is null or b.id is null then
    return jsonb_build_object('ok', false, 'error', 'Record not found.');
  end if;
  sc := fn_score_pair(fn_person_index_json(b) || jsonb_build_object('barangay_name', fn_person_barangay_name(b)), a);
  return jsonb_build_object('ok', true, 'score', (sc->>'score')::numeric, 'band', sc->>'band',
                            'reasons', sc->'reasons', 'flags', sc->'flags',
                            'a', fn_person_json(a), 'b', fn_person_json(b));
end $$;

-- ---------------------------------------------------------------------
-- Barangay directory helpers
-- ---------------------------------------------------------------------
create or replace function fn_barangays(p_include_inactive boolean default false, p_query text default '')
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', b.id, 'name', b.name, 'municipality', b.municipality, 'province', b.province,
      'district', b.district, 'active', b.active, 'created_at', b.created_at,
      'total_members', (select count(*) from persons p where p.barangay_id = b.id and p.status <> 'ARCHIVED' and p.merged_into is null),
      'active_members', (select count(*) from persons p where p.barangay_id = b.id and p.status = 'ACTIVE' and p.merged_into is null),
      'new_today', (select count(*) from persons p where p.barangay_id = b.id and p.created_at::date = current_date),
      'for_review', (select count(*) from persons p where p.barangay_id = b.id and p.status = 'FOR_REVIEW'),
      'possible_duplicates', (select count(distinct d.id) from duplicate_cases d
                               join persons pa on pa.id = d.person_id_a
                               join persons pb on pb.id = d.person_id_b
                               where d.status = 'PENDING' and (pa.barangay_id = b.id or pb.barangay_id = b.id)),
      'last_updated', (select max(p.updated_at) from persons p where p.barangay_id = b.id)
    ) as x
    from barangays b
    where (p_include_inactive or b.active)
      and (coalesce(btrim(p_query),'') = '' or b.name ilike '%'||btrim(p_query)||'%')
  ) s
$$;

create or replace function fn_upsert_barangay(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor users := fn_current_actor(); b barangays; v_id uuid := nullif(p->>'id','')::uuid;
begin
  perform fn_require_role('SYSTEM_ADMIN','ADMINISTRATOR');
  if coalesce(btrim(p->>'name'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'Barangay name is required.');
  end if;

  if v_id is null then
    insert into barangays (name, municipality, province, district, active, notes)
    values (btrim(p->>'name'), coalesce(nullif(p->>'municipality',''),'Nabua'),
            coalesce(nullif(p->>'province',''),'Camarines Sur'), nullif(p->>'district',''),
            coalesce((p->>'active')::boolean, true), nullif(p->>'notes',''))
    returning * into b;
    insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                            new_values, session_info)
    values (actor.id, actor.name, actor.role, 'BARANGAY_CREATED', 'BARANGAYS', b.id, b.name, to_jsonb(b), fn_session_info());
  else
    update barangays set name = btrim(p->>'name'),
           municipality = coalesce(nullif(p->>'municipality',''), municipality),
           province = coalesce(nullif(p->>'province',''), province),
           district = nullif(p->>'district',''),
           active = coalesce((p->>'active')::boolean, active),
           notes = nullif(p->>'notes',''),
           updated_at = now()
     where id = v_id returning * into b;
    insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                            new_values, session_info)
    values (actor.id, actor.name, actor.role, 'BARANGAY_UPDATED', 'BARANGAYS', b.id, b.name, to_jsonb(b), fn_session_info());
  end if;

  return jsonb_build_object('ok', true, 'barangay', to_jsonb(b));
end $$;


-- #####################################################################
-- # 0006_rpc_import_admin.sql
-- #####################################################################

-- =====================================================================
-- NMBR — 0006_rpc_import_admin.sql
-- Bulk import staging, dashboard aggregates, data quality, reports,
-- audit listing and user/settings management.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Normalise one imported row into canonical fields + validation issues.
-- ---------------------------------------------------------------------
create or replace function fn_import_normalize_row(p_row jsonb, p_default_barangay uuid default null)
returns jsonb language plpgsql immutable as $$
declare
  issues text[] := '{}';
  severity text := 'OK';
  dob date := fn_norm_date(coalesce(p_row->>'date_of_birth', p_row->>'birthdate'));
  contact text := nullif(btrim(coalesce(p_row->>'contact_number', p_row->>'contact')), '');
  sex text := upper(btrim(coalesce(p_row->>'sex', '')));
  first text := btrim(coalesce(p_row->>'first_name',''));
  last text := btrim(coalesce(p_row->>'last_name',''));
  mid text := nullif(btrim(coalesce(p_row->>'middle_name','')), '');
  brgy uuid := nullif(coalesce(p_row->>'barangay_id',''), '')::uuid;
  norm jsonb;
begin
  if first = '' then issues := array_append(issues, 'MISSING_FIRST_NAME'); severity := 'ERROR'; end if;
  if last = '' then issues := array_append(issues, 'MISSING_LAST_NAME'); severity := 'ERROR'; end if;

  if coalesce(btrim(coalesce(p_row->>'date_of_birth', p_row->>'birthdate')), '') <> '' and dob is null then
    issues := array_append(issues, 'INVALID_DATE_OF_BIRTH');
    severity := case when severity = 'ERROR' then 'ERROR' else 'WARNING' end;
  elsif dob is null then
    issues := array_append(issues, 'MISSING_BIRTHDATE');
    severity := case when severity = 'ERROR' then 'ERROR' else 'WARNING' end;
  elsif dob > current_date then
    issues := array_append(issues, 'BIRTHDATE_IN_FUTURE');
    severity := 'ERROR';
  end if;

  if sex not in ('MALE','FEMALE') then
    if sex in ('M','1') then sex := 'MALE';
    elsif sex in ('F','2') then sex := 'FEMALE';
    else
      sex := null;
      issues := array_append(issues, 'MISSING_OR_INVALID_SEX');
      severity := case when severity = 'ERROR' then 'ERROR' else 'WARNING' end;
    end if;
  end if;

  if contact is not null and length(fn_norm_digits(contact)) < 7 then
    issues := array_append(issues, 'INVALID_CONTACT_NUMBER');
    severity := case when severity = 'ERROR' then 'ERROR' else 'WARNING' end;
  elsif contact is null then
    issues := array_append(issues, 'MISSING_CONTACT');
  end if;

  if brgy is null and p_default_barangay is null then
    issues := array_append(issues, 'MISSING_BARANGAY');
    severity := case when severity = 'ERROR' then 'ERROR' else 'WARNING' end;
  end if;

  if coalesce(btrim(coalesce(p_row->>'address','')), '') = '' then
    issues := array_append(issues, 'INCOMPLETE_ADDRESS');
  end if;

  if p_row->>'reference_no' is not null and btrim(p_row->>'reference_no') <> '' then
    issues := array_append(issues, 'PROVIDED_REFERENCE_NO');
  end if;

  norm := jsonb_build_object(
    'first_name', initcap(lower(first)),
    'middle_name', case when mid is null then null else initcap(lower(mid)) end,
    'last_name', initcap(lower(last)),
    'suffix', nullif(upper(btrim(coalesce(p_row->>'suffix',''))), ''),
    'date_of_birth', dob,
    'sex', sex,
    'civil_status', nullif(upper(btrim(coalesce(p_row->>'civil_status',''))), ''),
    'contact_number', contact,
    'address', nullif(btrim(coalesce(p_row->>'address','')), ''),
    'purok', nullif(btrim(coalesce(p_row->>'purok', p_row->>'sitio','')), ''),
    'barangay_id', coalesce(brgy, p_default_barangay),
    'remarks', nullif(btrim(coalesce(p_row->>'remarks','')), '')
  );

  return jsonb_build_object('normalized', norm, 'issues', to_jsonb(issues), 'severity', severity);
end $$;

create or replace function fn_import_add_rows(p_batch_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  b import_batches;
  r jsonb;
  normres jsonb;
  idx int := 0;
  inserted int := 0;
  seen_key text;
  seen_keys text[] := '{}';
  matches jsonb;
  top jsonb;
  band text;
  score numeric;
  sev text;
  issues jsonb;
  person_id uuid;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER');

  select * into b from import_batches where id = p_batch_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Import batch not found.');
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    idx := idx + 1;
    normres := fn_import_normalize_row(r, (b.mapping->>'default_barangay_id')::uuid);
    issues := normres->'issues';
    sev := normres->>'severity';

    seen_key := fn_identity_key(normres->'normalized'->>'first_name', normres->'normalized'->>'middle_name',
                                normres->'normalized'->>'last_name', normres->'normalized'->>'suffix',
                                (normres->'normalized'->>'date_of_birth')::date);

    if seen_key <> '||||' and seen_key = any(seen_keys) then
      issues := issues || '["DUPLICATE_IN_FILE"]'::jsonb;
      sev := case when sev = 'ERROR' then 'ERROR' else 'WARNING' end;
    elsif seen_key <> '||||' then
      seen_keys := seen_keys || seen_key;
    end if;

    person_id := null; score := null; band := null;
    if sev <> 'ERROR' then
      matches := fn_check_person_duplicates(normres->'normalized', 1, null);
      if jsonb_array_length(matches) > 0 then
        top := matches->0;
        score := (top->>'score')::numeric;
        band := top->>'band';
        person_id := (top->'person'->>'id')::uuid;
        if band = 'VERY_LIKELY' then
          issues := issues || '["EXISTING_MEMBER_MATCH"]'::jsonb;
        elsif band in ('POSSIBLE','POTENTIAL') then
          issues := issues || '["POSSIBLE_EXISTING_MEMBER"]'::jsonb;
          sev := case when sev = 'ERROR' then 'ERROR' else 'WARNING' end;
        end if;
      end if;
    end if;

    insert into import_rows (batch_id, row_no, raw, normalized, validation, issues, severity,
                             match_score, match_person_id, decision)
    values (p_batch_id, idx, r, normres->'normalized',
            jsonb_build_object(
              'issues', issues, 'severity', sev, 'band', band,
              'block_last', left(fn_norm_name(normres->'normalized'->>'last_name'), 2),
              'block_phonetic', fn_phonetic(normres->'normalized'->>'last_name') || '|'
                                || fn_phonetic(normres->'normalized'->>'first_name'),
              'block_dob', normres->'normalized'->>'date_of_birth',
              'block_contact', fn_norm_contact(normres->'normalized'->>'contact_number')),
            array(select jsonb_array_elements_text(issues)), sev, score, person_id,
            case when sev = 'ERROR' then 'SKIP'
                 when band = 'VERY_LIKELY' then 'SKIP'
                 else 'PENDING' end);
    inserted := inserted + 1;
  end loop;

  -- ------------------------------------------------------------------
  -- In-file duplicate detection. Fuzzy (not just exact) so that
  -- "JUAN DELA CRUZ" vs "Juan Dela  Cruz" or a missing middle name is
  -- caught inside the same upload. Blocking keys keep this linear.
  -- ------------------------------------------------------------------
  with candidates as (
    select cur.id as dup_id,
           fn_score_json(cur.normalized, prev.normalized, null, null) as sc
      from import_rows cur
      join import_rows prev
        on prev.batch_id = cur.batch_id
       and prev.row_no < cur.row_no
       and ( (cur.validation->>'block_last') = (prev.validation->>'block_last')
          or (cur.validation->>'block_phonetic') = (prev.validation->>'block_phonetic')
          or (cur.validation->>'block_contact') = (prev.validation->>'block_contact')
          or (cur.validation->>'block_dob') = (prev.validation->>'block_dob') )
     where cur.batch_id = p_batch_id
  ),
  best as (
    select dup_id, max((sc->>'score')::numeric) as top_score,
           (array_agg(sc order by (sc->>'score')::numeric desc))[1] as top_detail
      from candidates group by dup_id
  )
  update import_rows ir
     set issues = array_append(ir.issues, 'DUPLICATE_IN_FILE'),
         severity = case when ir.severity = 'ERROR' then 'ERROR' else 'WARNING' end,
         validation = ir.validation || jsonb_build_object('in_file_score', bu.top_score,
                        'in_file_details', bu.top_detail, 'in_file_duplicate', true)
    from best bu
   where ir.id = bu.dup_id
     and bu.top_score >= coalesce((fn_duplicate_thresholds()->>'warn')::numeric, 80);

  update import_batches set total_rows = total_rows + inserted,
         new_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'OK'),
         duplicate_rows = (select count(*) from import_rows where batch_id = p_batch_id and match_score is not null),
         error_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'ERROR')
   where id = p_batch_id;

  return jsonb_build_object('ok', true, 'inserted', inserted);
end $$;

create or replace function fn_import_create_batch(
  p_file_name text,
  p_mapping jsonb default '{}'::jsonb,
  p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_id uuid;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');
  insert into import_batches (file_name, mapping, created_by)
  values (coalesce(nullif(btrim(p_file_name),''), 'upload.csv'), p_mapping, actor.id)
  returning id into v_id;

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    perform fn_import_add_rows(v_id, p_rows);
  end if;

  return jsonb_build_object('ok', true, 'batch_id', v_id);
end $$;

create or replace function fn_import_summary(p_batch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s jsonb;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER');
  select jsonb_build_object(
    'batch_id', b.id, 'file_name', b.file_name, 'status', b.status, 'created_at', b.created_at,
    'total_rows', (select count(*) from import_rows where batch_id = b.id),
    'clean_rows', (select count(*) from import_rows where batch_id = b.id and severity = 'OK'),
    'warning_rows', (select count(*) from import_rows where batch_id = b.id and severity = 'WARNING'),
    'error_rows', (select count(*) from import_rows where batch_id = b.id and severity = 'ERROR'),
    'unique_rows', (select count(*) from import_rows where batch_id = b.id and match_score is null and severity <> 'ERROR'),
    'duplicate_rows', (select count(*) from import_rows where batch_id = b.id and match_score is not null),
    'in_file_duplicates', (select count(*) from import_rows where batch_id = b.id and 'DUPLICATE_IN_FILE' = any(issues)),
    'missing_birthdates', (select count(*) from import_rows where batch_id = b.id and 'MISSING_BIRTHDATE' = any(issues)),
    'invalid_dates', (select count(*) from import_rows where batch_id = b.id and 'INVALID_DATE_OF_BIRTH' = any(issues)),
    'missing_sex', (select count(*) from import_rows where batch_id = b.id and 'MISSING_OR_INVALID_SEX' = any(issues)),
    'invalid_contacts', (select count(*) from import_rows where batch_id = b.id and 'INVALID_CONTACT_NUMBER' = any(issues)),
    'missing_barangay', (select count(*) from import_rows where batch_id = b.id and 'MISSING_BARANGAY' = any(issues)),
    'approved_rows', (select count(*) from import_rows where batch_id = b.id and decision = 'IMPORT'),
    'imported_rows', (select count(*) from import_rows where batch_id = b.id and imported_person_id is not null),
    'issue_breakdown', (select coalesce(jsonb_object_agg(i, c), '{}'::jsonb) from (
        select unnest(issues) as i, count(*) as c from import_rows where batch_id = b.id group by 1) t)
  ) into s
  from import_batches b where b.id = p_batch_id;

  return coalesce(s, jsonb_build_object('error','Batch not found'));
end $$;

create or replace function fn_import_rows(
  p_batch_id uuid,
  p_severity text default null,
  p_decision text default null,
  p_limit int default 50,
  p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows_json jsonb; lim int := least(greatest(coalesce(p_limit,50),1), 500);
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER');
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'row_no', r.row_no, 'raw', r.raw, 'normalized', r.normalized,
      'issues', r.issues, 'severity', r.severity, 'match_score', r.match_score,
      'band', r.validation->>'band', 'decision', r.decision,
      'match_person', case when r.match_person_id is null then null else fn_person_index_json(p) end,
      'imported_person_id', r.imported_person_id) order by r.row_no), '[]'::jsonb)
  into rows_json
  from (select * from import_rows
         where batch_id = p_batch_id
           and (p_severity is null or severity = p_severity)
           and (p_decision is null or decision = p_decision)
         order by row_no limit lim offset greatest(coalesce(p_offset,0),0)) r
  left join persons p on p.id = r.match_person_id;
  return jsonb_build_object('rows', rows_json);
end $$;

create or replace function fn_import_set_decision(p_row_id bigint, p_decision text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER');
  if p_decision not in ('PENDING','IMPORT','SKIP','LINK') then
    return jsonb_build_object('ok', false, 'error', 'Invalid decision.');
  end if;
  update import_rows set decision = p_decision where id = p_row_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function fn_import_set_all_decisions(p_batch_id uuid, p_severity text, p_decision text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');
  if p_decision not in ('PENDING','IMPORT','SKIP','LINK') then
    return jsonb_build_object('ok', false, 'error', 'Invalid decision.');
  end if;
  update import_rows set decision = p_decision
   where batch_id = p_batch_id and (p_severity is null or severity = p_severity)
     and not (p_decision = 'IMPORT' and severity = 'ERROR');
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'updated', n);
end $$;

-- Commits only approved + clean rows. Never blindly imports everything.
create or replace function fn_import_commit(p_batch_id uuid, p_default_barangay uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  b import_batches;
  r record;
  v_new persons;
  imported int := 0;
  skipped int := 0;
  linked int := 0;
  dupes int := 0;
  dup_result jsonb;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');

  select * into b from import_batches where id = p_batch_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Import batch not found.');
  end if;
  if b.status = 'IMPORTED' then
    return jsonb_build_object('ok', false, 'error', 'This batch was already imported.');
  end if;

  for r in select * from import_rows
            where batch_id = p_batch_id and decision = 'IMPORT' and severity <> 'ERROR' and imported_person_id is null
            order by row_no
  loop
    -- final live duplicate check per row (registry may have changed since staging)
    dup_result := fn_create_person(
      r.normalized || jsonb_build_object('barangay_id', coalesce(r.normalized->>'barangay_id', p_default_barangay::text)),
      false, 'Bulk import: ' || b.file_name);

    if coalesce((dup_result->>'ok')::boolean, false) then
      update import_rows set imported_person_id = (dup_result->'person'->>'id')::uuid, decision = 'IMPORT'
       where id = r.id;
      imported := imported + 1;
    elsif dup_result->>'code' = 'DUPLICATE_REVIEW_REQUIRED' then
      -- never import a likely duplicate: park it for review
      update import_rows
         set decision = 'SKIP',
             severity = 'WARNING',
             validation = validation || jsonb_build_object('parked_for_review', true),
             match_score = coalesce(match_score, ((dup_result->'matches'->0)->>'score')::numeric),
             match_person_id = coalesce(match_person_id, ((dup_result->'matches'->0)->'person'->>'id')::uuid),
             issues = array(select distinct unnest(issues || array['EXISTING_MEMBER_MATCH']))
       where id = r.id;
      -- Likely duplicates are held back, never imported silently. The staged
      -- row keeps the matched member id, score and reasons for the review screen.
      dupes := dupes + 1;
    else
      update import_rows set decision = 'SKIP', validation = validation || jsonb_build_object('error', dup_result->>'error')
       where id = r.id;
      skipped := skipped + 1;
    end if;
  end loop;

  linked := (select count(*) from import_rows where batch_id = p_batch_id and decision = 'LINK');

  update import_batches
     set status = 'IMPORTED', imported_rows = (select count(*) from import_rows where batch_id = p_batch_id and imported_person_id is not null),
         committed_at = now()
   where id = p_batch_id;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          new_values, reason, session_info)
  values (actor.id, actor.name, actor.role, 'IMPORTED', 'IMPORT_BATCH', p_batch_id, b.file_name,
          jsonb_build_object('imported', imported, 'duplicates_parked', dupes,
                             'skipped', skipped, 'linked_to_existing', linked),
          'Bulk import committed', fn_session_info());

  return jsonb_build_object('ok', true, 'imported', imported, 'duplicates_parked', dupes,
    'skipped', skipped, 'linked', linked,
    'message', imported || ' record(s) imported; ' || dupes || ' likely duplicate(s) were held back for review.');
end $$;

-- ---------------------------------------------------------------------
-- Read-only bulk duplicate check (used by the client-side importer)
-- ---------------------------------------------------------------------
create or replace function fn_bulk_check_duplicates(p_rows jsonb, p_limit_per_row int default 3)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  out_rows jsonb := '[]'::jsonb;
  r jsonb;
  matches jsonb;
  idx int := 0;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN');
  for r in select * from jsonb_array_elements(p_rows) loop
    idx := idx + 1;
    matches := fn_check_person_duplicates(r, least(greatest(coalesce(p_limit_per_row,3),1),10), null);
    out_rows := out_rows || jsonb_build_array(jsonb_build_object('index', idx, 'matches', matches));
  end loop;
  return out_rows;
end $$;

-- ---------------------------------------------------------------------
-- DASHBOARD (requirement 2)
-- ---------------------------------------------------------------------
create or replace function fn_dashboard_stats()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select jsonb_build_object(
    'total_barangays', (select count(*) from barangays),
    'active_barangays', (select count(*) from barangays where active),
    'total_members', (select count(*) from persons where status <> 'ARCHIVED' and merged_into is null),
    'active_members', (select count(*) from persons where status = 'ACTIVE' and merged_into is null),
    'new_today', (select count(*) from persons where created_at::date = current_date),
    'updated_today', (select count(*) from audit_logs
                       where action = 'UPDATED' and timestamp::date = current_date),
    'possible_duplicates', (select count(*) from duplicate_cases where status = 'PENDING'),
    'pending_duplicate_cases', (select count(*) from duplicate_cases where status = 'PENDING'),
    'records_requiring_attention', (
        select count(*) from persons p
         where p.status <> 'ARCHIVED' and p.merged_into is null
           and (p.status = 'FOR_REVIEW'
                or p.date_of_birth is null
                or p.sex is null
                or p.barangay_id is null
                or p.address is null
                or (p.contact_search <> '' and length(p.contact_search) < 7)
                or exists (select 1 from duplicate_cases d
                            where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))),
    'archived_records', (select count(*) from persons where status = 'ARCHIVED'),
    'merged_records', (select count(*) from persons where merged_into is not null),
    'transferred_this_year', (select count(distinct h.person_id) from member_barangay_history h
                               where h.effective_from >= date_trunc('year', current_date)
                                 and exists (select 1 from member_barangay_history h2
                                              where h2.person_id = h.person_id and h2.id <> h.id)),
    'last_activity', (select max(timestamp) from audit_logs)
  ) into s;
  return s;
end $$;

create or replace function fn_data_quality()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  return jsonb_build_array(
    jsonb_build_object('id','possible_duplicates','label','Possible duplicates','severity','high',
      'description','Open duplicate cases awaiting review.',
      'count',(select count(*) from duplicate_cases where status = 'PENDING'),
      'filter', jsonb_build_object('duplicates_only', true)),
    jsonb_build_object('id','missing_birthdate','label','Missing birthdates','severity','medium',
      'description','Records without a date of birth — weakens duplicate detection.',
      'count',(select count(*) from persons where date_of_birth is null and status <> 'ARCHIVED' and merged_into is null),
      'filter', jsonb_build_object('attention','missing_birthdate')),
    jsonb_build_object('id','missing_sex','label','Missing sex','severity','medium',
      'description','Records without sex recorded.',
      'count',(select count(*) from persons where sex is null and status <> 'ARCHIVED' and merged_into is null),
      'filter', jsonb_build_object('attention','missing_sex')),
    jsonb_build_object('id','missing_barangay','label','Missing barangay','severity','high',
      'description','Members not assigned to any barangay.',
      'count',(select count(*) from persons where barangay_id is null and status <> 'ARCHIVED' and merged_into is null),
      'filter', jsonb_build_object('attention','missing_barangay')),
    jsonb_build_object('id','invalid_contact','label','Invalid contact numbers','severity','medium',
      'description','Contact numbers with fewer than 7 digits.',
      'count',(select count(*) from persons where contact_search <> '' and length(contact_search) < 7 and status <> 'ARCHIVED'),
      'filter', jsonb_build_object('attention','invalid_contact')),
    jsonb_build_object('id','duplicate_contact','label','Shared contact numbers','severity','low',
      'description','One number used by several records — verify before merging (families often share a number).',
      'count',(select coalesce(sum(c - 1), 0) from (
                 select contact_search, count(*) c from persons
                  where contact_search <> '' and length(contact_search) >= 7 and status <> 'ARCHIVED' and merged_into is null
                  group by 1 having count(*) > 1) t),
      'filter', jsonb_build_object('quality','duplicate_contact')),
    jsonb_build_object('id','incomplete_address','label','Incomplete addresses','severity','low',
      'description','Records with no address or no purok recorded.',
      'count',(select count(*) from persons where (address is null or purok is null) and status <> 'ARCHIVED' and merged_into is null),
      'filter', jsonb_build_object('attention','incomplete_address')),
    jsonb_build_object('id','inconsistent_names','label','Inconsistent names','severity','low',
      'description','Records whose stored name no longer matches the normalised form (unusual characters or spacing).',
      'count',(select count(*) from persons where name_search <> fn_norm_text(concat_ws(' ', first_name, middle_name, last_name, suffix))),
      'filter', jsonb_build_object('quality','inconsistent_names')),
    jsonb_build_object('id','for_review','label','Records flagged for review','severity','high',
      'description','Records raised during duplicate handling.',
      'count',(select count(*) from persons where status = 'FOR_REVIEW' and merged_into is null),
      'filter', jsonb_build_object('for_review', true)),
    jsonb_build_object('id','archived','label','Archived records','severity','low',
      'description','Soft-deleted or merged records retained for the audit trail.',
      'count',(select count(*) from persons where status = 'ARCHIVED'),
      'filter', jsonb_build_object('status','ARCHIVED')),
    jsonb_build_object('id','same_name_different_dob','label','Same name, different birthdate','severity','medium',
      'description','Records sharing a full name but with conflicting birthdates — worth a spot check.',
      'count',(select coalesce(sum(c - 1), 0) from (
                 select name_search, count(*) c from persons
                  where status <> 'ARCHIVED' and merged_into is null and date_of_birth is not null
                  group by 1 having count(distinct date_of_birth) > 1) t),
      'filter', jsonb_build_object('quality','same_name_different_dob'))
  );
end $$;

-- Records matching a data-quality bucket (used when a metric is clicked)
create or replace function fn_quality_records(p_metric text, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows_json jsonb; total bigint;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');

  if p_metric = 'duplicate_contact' then
    select coalesce(jsonb_agg(jsonb_build_object('contact', t.contact_search,
             'members', (select coalesce(jsonb_agg(fn_person_index_json(p)), '[]'::jsonb)
                          from persons p where p.contact_search = t.contact_search and p.status <> 'ARCHIVED'))), '[]'::jsonb)
      into rows_json
      from (select contact_search from persons
             where contact_search <> '' and length(contact_search) >= 7 and status <> 'ARCHIVED' and merged_into is null
             group by 1 having count(*) > 1
             order by count(*) desc limit least(greatest(coalesce(p_limit,50),1),200) offset greatest(coalesce(p_offset,0),0)) t;
    return jsonb_build_object('rows', rows_json, 'metric', p_metric);
  end if;

  if p_metric = 'same_name_different_dob' then
    select coalesce(jsonb_agg(jsonb_build_object('name', t.name_search,
             'members', (select coalesce(jsonb_agg(fn_person_index_json(p)), '[]'::jsonb)
                          from persons p where p.name_search = t.name_search and p.status <> 'ARCHIVED'))), '[]'::jsonb)
      into rows_json
      from (select name_search from persons
             where status <> 'ARCHIVED' and merged_into is null and date_of_birth is not null
             group by 1 having count(distinct date_of_birth) > 1
             limit least(greatest(coalesce(p_limit,50),1),200) offset greatest(coalesce(p_offset,0),0)) t;
    return jsonb_build_object('rows', rows_json, 'metric', p_metric);
  end if;

  if p_metric = 'inconsistent_names' then
    select coalesce(jsonb_agg(fn_person_index_json(p)), '[]'::jsonb) into rows_json
      from (select * from persons
             where name_search <> fn_norm_text(concat_ws(' ', first_name, middle_name, last_name, suffix))
             limit least(greatest(coalesce(p_limit,50),1),200)) p;
    return jsonb_build_object('rows', rows_json, 'metric', p_metric);
  end if;

  return jsonb_build_object('rows', '[]'::jsonb, 'metric', p_metric);
end $$;

-- ---------------------------------------------------------------------
-- REPORTS (requirement 23)
-- ---------------------------------------------------------------------
create or replace function fn_reports(
  p_report text,
  p_from date default null,
  p_to date default null,
  p_barangay_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d_from date := coalesce(p_from, date_trunc('year', current_date)::date);
  d_to date := coalesce(p_to, current_date);
  out jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');

  if p_report = 'by_barangay' then
    select coalesce(jsonb_agg(x order by (x->>'total')::int desc), '[]'::jsonb) into out from (
      select jsonb_build_object('barangay', b.name,
        'total', (select count(*) from persons p where p.barangay_id = b.id and p.status <> 'ARCHIVED' and p.merged_into is null),
        'active', (select count(*) from persons p where p.barangay_id = b.id and p.status = 'ACTIVE'),
        'inactive', (select count(*) from persons p where p.barangay_id = b.id and p.status = 'INACTIVE'),
        'for_review', (select count(*) from persons p where p.barangay_id = b.id and p.status = 'FOR_REVIEW'),
        'new_in_period', (select count(*) from persons p where p.barangay_id = b.id and p.created_at::date between d_from and d_to),
        'male', (select count(*) from persons p where p.barangay_id = b.id and p.sex = 'MALE' and p.status <> 'ARCHIVED'),
        'female', (select count(*) from persons p where p.barangay_id = b.id and p.sex = 'FEMALE' and p.status <> 'ARCHIVED'),
        'duplicates', (select count(distinct d.id) from duplicate_cases d
                        join persons pa on pa.id = d.person_id_a join persons pb on pb.id = d.person_id_b
                        where d.status = 'PENDING' and (pa.barangay_id = b.id or pb.barangay_id = b.id))
      ) as x from barangays b where (p_barangay_id is null or b.id = p_barangay_id) and b.active
    ) s;

  elsif p_report = 'by_sex' then
    select coalesce(jsonb_agg(jsonb_build_object('sex', coalesce(sex, 'NOT RECORDED'), 'total', c) order by c desc), '[]'::jsonb)
      into out from (
        select sex, count(*) c from persons
         where status <> 'ARCHIVED' and merged_into is null and (p_barangay_id is null or barangay_id = p_barangay_id)
         group by 1) t;

  elsif p_report = 'by_age_group' then
    select coalesce(jsonb_agg(jsonb_build_object('group', g.label, 'total', coalesce(c.n, 0)) order by g.sort), '[]'::jsonb)
      into out
      from (values ('Under 5', 1, 0, 4), ('5–12 (Child)', 2, 5, 12), ('13–17 (Adolescent)', 3, 13, 17),
                   ('18–29 (Young adult)', 4, 18, 29), ('30–44 (Adult)', 5, 30, 44), ('45–59 (Middle age)', 6, 45, 59),
                   ('60–74 (Senior)', 7, 60, 74), ('75 and above', 8, 75, 200), ('Not recorded', 9, -1, -1)) as g(label, sort, min_age, max_age)
      left join (
        select age_b, count(*) n from (
          select case
                   when date_of_birth is null then -1
                   else extract(year from age(current_date, date_of_birth))::int end as age_b
          from persons
           where status <> 'ARCHIVED' and merged_into is null
             and (p_barangay_id is null or barangay_id = p_barangay_id)) a
        group by 1) c on (g.min_age = -1 and c.age_b = -1)
                     or (g.min_age >= 0 and c.age_b between g.min_age and g.max_age);

  elsif p_report = 'new_members' then
    select coalesce(jsonb_agg(fn_person_index_json(p) order by p.created_at desc), '[]'::jsonb) into out
      from persons p where p.created_at::date between d_from and d_to
        and (p_barangay_id is null or p.barangay_id = p_barangay_id) limit 500;

  elsif p_report = 'transferred' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'person', fn_person_index_json(p),
        'barangay', b.name, 'effective_from', h.effective_from, 'effective_to', h.effective_to,
        'reason', h.reason, 'notes', h.notes, 'recorded_at', h.created_at,
        'recorded_by', (select u.name from users u where u.id = h.created_by)) order by h.effective_from desc), '[]'::jsonb)
      into out
      from member_barangay_history h
      join persons p on p.id = h.person_id
      join barangays b on b.id = h.barangay_id
      where h.effective_from between d_from and d_to
        and exists (select 1 from member_barangay_history h2
                     where h2.person_id = h.person_id and h2.id <> h.id)
        and (p_barangay_id is null or h.barangay_id = p_barangay_id) limit 500;

  elsif p_report = 'possible_duplicates' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'case_id', d.id, 'score', d.match_score, 'band', d.match_band, 'status', d.status,
        'fields', d.matching_fields, 'created_at', d.created_at,
        'person_a', fn_person_index_json(a), 'person_b', fn_person_index_json(b)) order by d.match_score desc), '[]'::jsonb)
      into out from duplicate_cases d
      join persons a on a.id = d.person_id_a join persons b on b.id = d.person_id_b
      where d.status = 'PENDING' and (p_barangay_id is null or a.barangay_id = p_barangay_id or b.barangay_id = p_barangay_id)
      limit 500;

  elsif p_report = 'resolved_duplicates' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'case_id', d.id, 'score', d.match_score, 'status', d.status, 'resolution', d.resolution,
        'notes', d.notes, 'reviewed_by', d.reviewed_by_name, 'reviewed_at', d.reviewed_at,
        'person_a', fn_person_index_json(a), 'person_b', fn_person_index_json(b)) order by d.reviewed_at desc), '[]'::jsonb)
      into out from duplicate_cases d
      join persons a on a.id = d.person_id_a join persons b on b.id = d.person_id_b
      where d.status <> 'PENDING' and coalesce(d.reviewed_at::date, d.updated_at::date) between d_from and d_to
      limit 500;

  elsif p_report = 'data_quality' then
    out := fn_data_quality();

  elsif p_report = 'encoder_activity' then
    select coalesce(jsonb_agg(x order by (x->>'total')::int desc), '[]'::jsonb) into out from (
      select jsonb_build_object(
        'user', coalesce(a.user_name, 'Unknown'),
        'created', coalesce(sum(case when a.action = 'CREATED' then 1 else 0 end), 0)::int,
        'updated', coalesce(sum(case when a.action = 'UPDATED' then 1 else 0 end), 0)::int,
        'transferred', coalesce(sum(case when a.action = 'TRANSFERRED' then 1 else 0 end), 0)::int,
        'merged', coalesce(sum(case when a.action = 'MERGED' then 1 else 0 end), 0)::int,
        'duplicate_reviews', coalesce(sum(case when a.action = 'DUPLICATE_REVIEWED' then 1 else 0 end), 0)::int,
        'imported', coalesce(sum(case when a.action = 'IMPORTED' then 1 else 0 end), 0)::int,
        'total', count(*)::int) as x
      from audit_logs a
      where a.timestamp::date between d_from and d_to
      group by coalesce(a.user_name, 'Unknown')) t;

  elsif p_report = 'audit_summary' then
    select coalesce(jsonb_agg(jsonb_build_object('action', action, 'total', c) order by c desc), '[]'::jsonb)
      into out from (select action, count(*) c from audit_logs
                      where timestamp::date between d_from and d_to group by 1) t;
  else
    return jsonb_build_object('error', 'Unknown report: ' || coalesce(p_report, 'null'));
  end if;

  return jsonb_build_object('report', p_report, 'from', d_from, 'to', d_to,
                            'generated_at', now(), 'rows', coalesce(out, '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- AUDIT LOG (requirement 15)
-- ---------------------------------------------------------------------
create or replace function fn_list_audit(
  p_query text default '',
  p_action text default null,
  p_entity text default null,
  p_user_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 50,
  p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows_json jsonb; total bigint; q text := btrim(coalesce(p_query,''));
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER','VIEWER');

  with filtered as (
    select a.* from audit_logs a
     where (p_action is null or a.action = p_action)
       and (p_entity is null or a.entity_type = p_entity)
       and (p_user_id is null or a.user_id = p_user_id)
       and (p_from is null or a.timestamp >= p_from)
       and (p_to is null or a.timestamp <= p_to)
       and (q = '' or a.entity_label ilike '%'||q||'%' or a.user_name ilike '%'||q||'%'
            or a.reason ilike '%'||q||'%' or a.action ilike '%'||q||'%')
  )
  select count(*) into total from filtered;

  with filtered as (
    select a.* from audit_logs a
     where (p_action is null or a.action = p_action)
       and (p_entity is null or a.entity_type = p_entity)
       and (p_user_id is null or a.user_id = p_user_id)
       and (p_from is null or a.timestamp >= p_from)
       and (p_to is null or a.timestamp <= p_to)
       and (q = '' or a.entity_label ilike '%'||q||'%' or a.user_name ilike '%'||q||'%'
            or a.reason ilike '%'||q||'%' or a.action ilike '%'||q||'%')
     order by a.timestamp desc
     limit least(greatest(coalesce(p_limit,50),1), 200) offset greatest(coalesce(p_offset,0),0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'user_id', a.user_id, 'user_name', coalesce(a.user_name,'System'),
      'user_role', a.user_role, 'action', a.action, 'entity_type', a.entity_type,
      'entity_id', a.entity_id, 'entity_label', a.entity_label,
      'old_values', a.old_values, 'new_values', a.new_values,
      'changed_fields', a.changed_fields, 'reason', a.reason,
      'session_info', a.session_info, 'timestamp', a.timestamp)
      order by a.timestamp desc), '[]'::jsonb)
    into rows_json from filtered a;

  return jsonb_build_object('total', coalesce(total,0), 'rows', rows_json);
end $$;

create or replace function fn_log_event(
  p_action text, p_entity_type text, p_entity_id uuid default null,
  p_entity_label text default null, p_new_values jsonb default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor users := fn_current_actor();
begin
  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id,
                          entity_label, new_values, reason, session_info)
  values (actor.id, actor.name, actor.role, p_action, p_entity_type, p_entity_id,
          p_entity_label, p_new_values, p_reason, fn_session_info());
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- USERS  (requirement 16)
-- ---------------------------------------------------------------------
create or replace function fn_list_users()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows_json jsonb;
begin
  perform fn_require_role('SYSTEM_ADMIN','ADMINISTRATOR');
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', u.id, 'auth_user_id', u.auth_user_id, 'name', u.name, 'email', u.email,
      'role', u.role, 'active', u.active, 'barangay_scope', u.barangay_scope,
      'created_at', u.created_at, 'last_login', u.last_login) order by u.name), '[]'::jsonb)
    into rows_json from users u;
  return rows_json;
end $$;

create or replace function fn_upsert_user(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor users := fn_current_actor(); u users; v_id uuid := nullif(p->>'id','')::uuid;
begin
  perform fn_require_role('SYSTEM_ADMIN');
  if coalesce(btrim(p->>'name'),'') = '' or coalesce(btrim(p->>'email'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'Name and email are required.');
  end if;
  if coalesce(p->>'role','') not in ('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER') then
    return jsonb_build_object('ok', false, 'error', 'Invalid role.');
  end if;

  if v_id is null then
    insert into users (name, email, role, active, barangay_scope)
    values (btrim(p->>'name'), lower(btrim(p->>'email')), (p->>'role')::user_role,
            coalesce((p->>'active')::boolean, true), nullif(p->>'barangay_scope','')::uuid)
    returning * into u;
  else
    update users set name = btrim(p->>'name'), email = lower(btrim(p->>'email')),
           role = (p->>'role')::user_role,
           active = coalesce((p->>'active')::boolean, active),
           barangay_scope = nullif(p->>'barangay_scope','')::uuid,
           updated_at = now()
     where id = v_id returning * into u;
    if not found then return jsonb_build_object('ok', false, 'error', 'User not found.'); end if;
  end if;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          new_values, session_info)
  values (actor.id, actor.name, actor.role, case when v_id is null then 'USER_CREATED' else 'USER_UPDATED' end,
          'USERS', u.id, u.name || ' (' || u.email || ')',
          jsonb_build_object('role', u.role, 'active', u.active), fn_session_info());

  return jsonb_build_object('ok', true, 'user', jsonb_build_object(
    'id', u.id, 'name', u.name, 'email', u.email, 'role', u.role, 'active', u.active,
    'barangay_scope', u.barangay_scope, 'created_at', u.created_at, 'last_login', u.last_login));
end $$;

-- Links a freshly signed-in Supabase user to a pre-provisioned profile row
create or replace function fn_link_auth_user()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := fn_auth_uid();
  u users;
  email text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not authenticated.'); end if;

  select * into u from users where auth_user_id = uid limit 1;
  if found then
    update users set last_login = now() where id = u.id;
    return jsonb_build_object('ok', true, 'user', jsonb_build_object(
      'id', u.id, 'name', u.name, 'email', u.email, 'role', u.role, 'active', u.active,
      'barangay_scope', u.barangay_scope, 'last_login', now()));
  end if;

  begin
    execute 'select email from auth.users where id = $1' into email using uid;
  exception when others then
    email := null;
  end;

  if email is null then return jsonb_build_object('ok', false, 'error', 'No profile is linked to this account.'); end if;

  select * into u from users where lower(email) = lower(email) and auth_user_id is null limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error',
      'This account is not registered in the NMBR user list. Ask the system administrator to add you.');
  end if;
  if not u.active then
    return jsonb_build_object('ok', false, 'error', 'This account has been deactivated.');
  end if;

  update users set auth_user_id = uid, last_login = now() where id = u.id;
  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label, session_info)
  values (u.id, u.name, u.role, 'LOGIN', 'USERS', u.id, u.name, fn_session_info());

  return jsonb_build_object('ok', true, 'user', jsonb_build_object(
    'id', u.id, 'name', u.name, 'email', u.email, 'role', u.role, 'active', u.active,
    'barangay_scope', u.barangay_scope, 'last_login', now()));
end $$;

-- ---------------------------------------------------------------------
-- SETTINGS
-- ---------------------------------------------------------------------
create or replace function fn_get_settings()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select jsonb_build_object(
    'weights', coalesce((select value from settings where key = 'duplicate_weights'), '{}'::jsonb),
    'thresholds', coalesce((select value from settings where key = 'duplicate_thresholds'), '{}'::jsonb),
    'system', coalesce((select value from settings where key = 'system'), '{}'::jsonb),
    'updated_at', (select max(updated_at) from settings)
  ) into out;
  return out;
end $$;

create or replace function fn_save_settings(p_weights jsonb, p_thresholds jsonb, p_system jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor users := fn_current_actor(); old jsonb;
begin
  perform fn_require_role('SYSTEM_ADMIN');
  old := fn_get_settings();

  if p_weights is not null then
    insert into settings (key, value, updated_by, updated_at) values ('duplicate_weights', p_weights, actor.id, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  end if;
  if p_thresholds is not null then
    if coalesce((p_thresholds->>'block')::numeric, 0) <= coalesce((p_thresholds->>'warn')::numeric, 0)
       or coalesce((p_thresholds->>'warn')::numeric, 0) <= coalesce((p_thresholds->>'notice')::numeric, 0) then
      return jsonb_build_object('ok', false, 'error', 'Thresholds must decrease from block → warn → notice.');
    end if;
    insert into settings (key, value, updated_by, updated_at) values ('duplicate_thresholds', p_thresholds, actor.id, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  end if;
  if p_system is not null then
    insert into settings (key, value, updated_by, updated_at) values ('system', p_system, actor.id, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_label,
                          old_values, new_values, session_info)
  values (actor.id, actor.name, actor.role, 'SETTINGS_UPDATED', 'SETTINGS', 'Duplicate detection rules',
          old, fn_get_settings(), fn_session_info());

  return jsonb_build_object('ok', true, 'settings', fn_get_settings());
end $$;


-- #####################################################################
-- # 0007_security_rls.sql
-- #####################################################################

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


-- #####################################################################
-- # 0008_health.sql
-- #####################################################################

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


-- #####################################################################
-- # 0009_fix_link_auth_user.sql
-- #####################################################################

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


-- #####################################################################
-- # 0010_search_created_since.sql
-- #####################################################################

-- ---------------------------------------------------------------------
-- 0010: "encoded since" drill-down for the member search.
--
-- The Barangay Directory and Dashboard "New today" cards link straight to
-- the member list restricted to records created on/after a given date
-- (the office passes local midnight). Without this parameter the cards
-- could only offer an unfiltered list, and the count on the card would
-- not match what the encoder sees. Idempotent: create or replace.
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE cannot change an argument list: without this drop the
-- database keeps the 12-argument twin and named-argument calls become
-- ambiguous. Dropping by exact signature removes only the old variant.
drop function if exists fn_search_persons(
  text, uuid, text, text, text, boolean, boolean, boolean, text, text, int, int);

create or replace function fn_search_persons(
  p_query text default '',
  p_barangay_id uuid default null,
  p_status text default null,
  p_sex text default null,
  p_purok text default null,
  p_duplicates_only boolean default false,
  p_for_review_only boolean default false,
  p_attention_only boolean default false,
  p_created_since date default null,
  p_sort text default 'name',
  p_dir text default 'asc',
  p_limit int default 25,
  p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q text := btrim(coalesce(p_query, ''));
  qn text := fn_norm_text(q);
  qd text := fn_norm_digits(q);
  qdate date := fn_norm_date(q);
  rows_json jsonb;
  total bigint;
  lim int := least(greatest(coalesce(p_limit, 25), 1), 200);
  off int := greatest(coalesce(p_offset, 0), 0);
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');

  with filtered as (
    select p.*
    from persons p
    where (p_barangay_id is null or p.barangay_id = p_barangay_id)
      and (p_status is null or p.status::text = p_status)
      and (p_sex is null or p.sex = p_sex)
      and (p_purok is null or fn_norm_text(p.purok) = fn_norm_text(p_purok))
      and (p.status <> 'ARCHIVED' or p_status = 'ARCHIVED')
      and (p_created_since is null or p.created_at::date >= p_created_since)
      and (not p_duplicates_only or exists (
            select 1 from duplicate_cases d
             where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (not p_for_review_only or p.status = 'FOR_REVIEW')
      and (not p_attention_only or p.date_of_birth is null or p.sex is null or p.barangay_id is null
           or p.address is null or p.purok is null
           or (p.contact_search <> '' and length(p.contact_search) < 7)
           or exists (select 1 from duplicate_cases d
                       where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (
        q = '' or
        (qn <> '' and p.name_search like '%' || qn || '%') or
        (qn <> '' and fn_similarity(p.name_search, qn) >= 0.45) or
        (qd <> '' and length(qd) >= 6 and p.contact_search = fn_norm_contact(qd)) or
        (qd <> '' and p.reference_no ilike '%' || qd || '%') or
        (qdate is not null and p.date_of_birth = qdate) or
        (qn <> '' and fn_norm_text(fn_person_barangay_name(p)) like '%' || qn || '%') or
        (qn <> '' and fn_norm_text(p.purok) like '%' || qn || '%')
      )
  )
  select count(*) into total from filtered;

  with filtered as (
    select p.* from persons p
    where (p_barangay_id is null or p.barangay_id = p_barangay_id)
      and (p_status is null or p.status::text = p_status)
      and (p_sex is null or p.sex = p_sex)
      and (p_purok is null or fn_norm_text(p.purok) = fn_norm_text(p_purok))
      and (p.status <> 'ARCHIVED' or p_status = 'ARCHIVED')
      and (p_created_since is null or p.created_at::date >= p_created_since)
      and (not p_duplicates_only or exists (
            select 1 from duplicate_cases d
             where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (not p_for_review_only or p.status = 'FOR_REVIEW')
      and (not p_attention_only or p.date_of_birth is null or p.sex is null or p.barangay_id is null
           or p.address is null or p.purok is null
           or (p.contact_search <> '' and length(p.contact_search) < 7)
           or exists (select 1 from duplicate_cases d
                       where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (
        q = '' or
        (qn <> '' and p.name_search like '%' || qn || '%') or
        (qn <> '' and fn_similarity(p.name_search, qn) >= 0.45) or
        (qd <> '' and length(qd) >= 6 and p.contact_search = fn_norm_contact(qd)) or
        (qd <> '' and p.reference_no ilike '%' || qd || '%') or
        (qdate is not null and p.date_of_birth = qdate) or
        (qn <> '' and fn_norm_text(fn_person_barangay_name(p)) like '%' || qn || '%') or
        (qn <> '' and fn_norm_text(p.purok) like '%' || qn || '%')
      )
    order by
      case when p_dir = 'asc' then
        case p_sort when 'updated' then null when 'barangay' then null else p.last_search end
      end asc nulls last,
      case when p_sort = 'updated' and p_dir = 'asc' then p.updated_at end asc,
      case when p_sort = 'updated' and p_dir = 'desc' then p.updated_at end desc,
      case when p_sort = 'barangay' and p_dir = 'asc' then fn_person_barangay_name(p) end asc,
      case when p_sort = 'barangay' and p_dir = 'desc' then fn_person_barangay_name(p) end desc,
      case when p_sort = 'name' and p_dir = 'desc' then p.last_search end desc,
      case when p_sort = 'dob' and p_dir = 'asc' then p.date_of_birth end asc nulls last,
      case when p_sort = 'dob' and p_dir = 'desc' then p.date_of_birth end desc nulls last,
      p.first_search asc, p.created_at desc
    limit lim offset off
  )
  select coalesce(jsonb_agg(fn_person_json(f)), '[]'::jsonb) into rows_json from filtered f;

  return jsonb_build_object('total', coalesce(total,0), 'rows', rows_json, 'limit', lim, 'offset', off);
end $$;


-- =====================================================================
--  Setup complete. Next: create the staff accounts under Authentication ->
--  Users, then add the matching rows to the users table (see
--  docs/DEPLOY_CLOUDFLARE.md, step 3). Demonstration data is a separate file.
-- =====================================================================
