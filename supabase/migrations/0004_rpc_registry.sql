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
