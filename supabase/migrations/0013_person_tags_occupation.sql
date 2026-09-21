-- ---------------------------------------------------------------------
-- 0013: community tags, occupation and household grouping from paper
-- lists (field request 2026-09-21, LP-TOPAS SOGOD layout).
--
-- Barangay programme lists carry more than identity: family leaders and
-- heads, programme tags in the remarks columns (AKAP, AICS/4PS, …) and
-- occupations. Before this migration those columns were silently dropped
-- on import. Tags are neutral, admin-visible labels: they never drive
-- eligibility for anything (docs/GO_LIVE.md §10 still stands).
-- ---------------------------------------------------------------------

alter table persons add column if not exists tags text[] not null default '{}';
alter table persons add column if not exists occupation text;
create index if not exists persons_tags_idx on persons using gin (tags);

-- Accepts a jsonb array of strings, a single string, or a ';'-separated
-- string; returns a de-duplicated, trimmed text array.
create or replace function fn_parse_tags(v jsonb)
returns text[] language sql immutable as $$
  select coalesce(array(
    select distinct btrim(x)
    from jsonb_array_elements_text(
           case when jsonb_typeof(v) = 'array' then v
                when v is null or jsonb_typeof(v) = 'null' then '[]'::jsonb
                else jsonb_build_array(v) end) as t(x)
    where btrim(x) <> ''
    order by 1), '{}')
$$;

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
    'tags', coalesce(p.tags, '{}'),
    'occupation', p.occupation,
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
    'status', p.status, 'tags', coalesce(p.tags, '{}'),
    'occupation', p.occupation, 'updated_at', p.updated_at,
    'identity_key', case when position('#' in p.identity_key) > 0 then null else p.identity_key end
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
  v_household uuid;
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

  -- Paper lists (e.g. LP-TOPAS) number families. Resolve the household or
  -- create it once, so family grouping from the list survives the import.
  if coalesce(btrim(p->>'household_no'),'') <> '' and nullif(p->>'barangay_id','') is not null then
    select id into v_household from households where household_no = btrim(p->>'household_no');
    if not found then
      insert into households (household_no, barangay_id, created_at, updated_at)
      values (btrim(p->>'household_no'), nullif(p->>'barangay_id','')::uuid, now(), now())
      returning id into v_household;
    end if;
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
    client_ref, created_by, updated_by, classification_code,
    tags, occupation)
  values (
    p->>'first_name', nullif(p->>'middle_name',''), p->>'last_name', nullif(p->>'suffix',''),
    fn_norm_date(p->>'date_of_birth'), nullif(p->>'sex',''), nullif(p->>'civil_status',''),
    nullif(p->>'contact_number',''), nullif(p->>'address',''), nullif(p->>'purok',''),
    nullif(p->>'barangay_id','')::uuid,
    coalesce(nullif(p->>'status',''), 'ACTIVE')::person_status,
    nullif(p->>'remarks',''), coalesce(v_household, nullif(p->>'household_id','')::uuid),
    v_client_ref, actor.id, actor.id, nullif(p->>'classification_code',''),
    fn_parse_tags(p->'tags'), nullif(p->>'occupation',''))
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
    tags         = case when p ? 'tags' then fn_parse_tags(p->'tags') else tags end,
    occupation   = case when p ? 'occupation' then nullif(p->>'occupation','') else occupation end,
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
