-- ---------------------------------------------------------------------
-- 0012: subsidy (ayuda) programmes + beneficiary lists, and a neutral
-- member classification code used during paper-list cross-checks.
-- Person write/read functions are recreated with the new column; all
-- keep their existing signatures, so CREATE OR REPLACE is safe here.
-- ---------------------------------------------------------------------
alter table persons add column if not exists classification_code text;

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
    'classification_code', p.classification_code,
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
    client_ref, created_by, updated_by, classification_code)
  values (
    p->>'first_name', nullif(p->>'middle_name',''), p->>'last_name', nullif(p->>'suffix',''),
    fn_norm_date(p->>'date_of_birth'), nullif(p->>'sex',''), nullif(p->>'civil_status',''),
    nullif(p->>'contact_number',''), nullif(p->>'address',''), nullif(p->>'purok',''),
    nullif(p->>'barangay_id','')::uuid,
    coalesce(nullif(p->>'status',''), 'ACTIVE')::person_status,
    nullif(p->>'remarks',''), nullif(p->>'household_id','')::uuid,
    v_client_ref, actor.id, actor.id, nullif(p->>'classification_code',''))
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
    classification_code = case when p ? 'classification_code' then nullif(p->>'classification_code','') else classification_code end,
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
-- Subsidy (ayuda) programmes and beneficiaries — field request 2026-09-18.
-- Programmes are municipal aid drives (bigasan, walang gutom, …);
-- beneficiaries are encoded per programme from barangay-validated paper
-- lists, cross-checked against the registry by a human encoder.
-- Eligibility is ALWAYS an explicit human decision per row: the system
-- deliberately contains no rule that includes or excludes a resident
-- from aid automatically (see docs/GO_LIVE.md §10).
-- ---------------------------------------------------------------------
create table if not exists subsidy_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  description text,
  period_start date,
  period_end date,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subsidy_beneficiaries (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references subsidy_programs(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  barangay_id uuid references barangays(id) on delete set null,
  classification_code text,
  verified boolean not null default false,
  paper_ref text,
  notes text,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint subsidy_once_per_program unique (program_id, person_id)
);
create index if not exists subsidy_benef_program_idx on subsidy_beneficiaries (program_id);
create index if not exists subsidy_benef_person_idx  on subsidy_beneficiaries (person_id);

create or replace function fn_subsidy_programs()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'description', s.description,
    'period_start', s.period_start, 'period_end', s.period_end,
    'active', s.active, 'created_at', s.created_at,
    'beneficiaries', (select count(*) from subsidy_beneficiaries b where b.program_id = s.id),
    'verified', (select count(*) from subsidy_beneficiaries b where b.program_id = s.id and b.verified)
  ) order by s.created_at desc), '[]'::jsonb) into rows from subsidy_programs s;
  return jsonb_build_object('rows', rows);
end $$;

create or replace function fn_subsidy_upsert_program(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_id uuid := nullif(p->>'id','')::uuid;
  v_row subsidy_programs;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');
  if v_id is null then
    insert into subsidy_programs (name, description, period_start, period_end, active, created_by)
    values (btrim(p->>'name'), nullif(p->>'description',''),
            nullif(p->>'period_start','')::date, nullif(p->>'period_end','')::date,
            coalesce((p->>'active')::boolean, true), actor.id)
    returning * into v_row;
  else
    update subsidy_programs set
      name = coalesce(nullif(btrim(p->>'name'),''), name),
      description = case when p ? 'description' then nullif(p->>'description','') else description end,
      period_start = case when p ? 'period_start' then nullif(p->>'period_start','')::date else period_start end,
      period_end = case when p ? 'period_end' then nullif(p->>'period_end','')::date else period_end end,
      active = case when p ? 'active' then (p->>'active')::boolean else active end,
      updated_at = now()
    where id = v_id
    returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'program', jsonb_build_object(
    'id', v_row.id, 'name', v_row.name, 'description', v_row.description,
    'period_start', v_row.period_start, 'period_end', v_row.period_end,
    'active', v_row.active, 'created_at', v_row.created_at));
end $$;

create or replace function fn_subsidy_beneficiaries(p_program_id uuid, p_barangay_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'program_id', b.program_id, 'person_id', b.person_id,
    'barangay_id', b.barangay_id, 'classification_code', b.classification_code,
    'verified', b.verified, 'paper_ref', b.paper_ref, 'notes', b.notes,
    'created_at', b.created_at,
    'person_name', concat_ws(' ', p.first_name, p.middle_name, p.last_name),
    'reference_no', p.reference_no, 'person_barangay', fn_person_barangay_name(p),
    'added_by_name', u.name
  ) order by p.last_search), '[]'::jsonb) into rows
  from subsidy_beneficiaries b
  join persons p on p.id = b.person_id
  left join users u on u.id = b.added_by
  where b.program_id = p_program_id
    and (p_barangay_id is null or b.barangay_id = p_barangay_id);
  return jsonb_build_object('rows', rows);
end $$;

create or replace function fn_subsidy_add_beneficiary(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_person persons;
  v_row subsidy_beneficiaries;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN');
  select * into v_person from persons where id = nullif(p->>'person_id','')::uuid;
  if v_person.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND',
      'error', 'That member is not in the registry on this device. Re-sync and try again.');
  end if;
  if exists (select 1 from subsidy_beneficiaries b
              where b.program_id = nullif(p->>'program_id','')::uuid and b.person_id = v_person.id) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_LISTED',
      'error', concat_ws(' ', v_person.first_name, v_person.last_name) ||
               ' is already on this programme list.');
  end if;
  insert into subsidy_beneficiaries (program_id, person_id, barangay_id, classification_code,
                                     verified, paper_ref, notes, added_by)
  values (nullif(p->>'program_id','')::uuid, v_person.id,
          coalesce(nullif(p->>'barangay_id',''), v_person.barangay_id::text)::uuid,
          nullif(p->>'classification_code',''), coalesce((p->>'verified')::boolean, false),
          nullif(p->>'paper_ref',''), nullif(p->>'notes',''), actor.id)
  returning * into v_row;
  return jsonb_build_object('ok', true, 'beneficiary', jsonb_build_object(
    'id', v_row.id, 'program_id', v_row.program_id, 'person_id', v_row.person_id,
    'barangay_id', v_row.barangay_id, 'classification_code', v_row.classification_code,
    'verified', v_row.verified, 'paper_ref', v_row.paper_ref, 'notes', v_row.notes,
    'created_at', v_row.created_at));
end $$;

create or replace function fn_subsidy_remove_beneficiary(p_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor users := fn_current_actor();
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');
  delete from subsidy_beneficiaries where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
