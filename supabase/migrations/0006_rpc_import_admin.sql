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
