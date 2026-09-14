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
