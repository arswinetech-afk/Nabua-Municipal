-- ---------------------------------------------------------------------
-- 0014: import staging at paper-list scale (field report 2026-09-21:
-- "canceling statement due to statement timeout" while staging LP-TOPAS).
--
-- Two quadratic costs hid in staging: every chunk re-ran the in-file
-- duplicate scan over ALL rows staged so far, and every row built full
-- person JSON for up to 400 duplicate candidates. In-file detection now
-- runs once per batch (fn_import_finalize_batch, also called by commit),
-- staging uses a lite scorer, and the bulk statements get an explicit
-- statement_timeout instead of the connection default.
-- ---------------------------------------------------------------------

-- The new 4-argument signature replaces the old one outright: with both
-- present, existing 3-argument calls passing an untyped NULL become
-- ambiguous ("function ... is not unique").
drop function if exists fn_check_person_duplicates(jsonb, int, uuid);

create or replace function fn_check_person_duplicates(
  p jsonb,
  p_limit int default 10,
  p_exclude_id uuid default null,
  p_lite boolean default false)
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
    limit (case when p_lite then 50 else 400 end)
  loop
    sc := fn_score_pair(p, r);
    if (sc->>'score')::numeric >= greatest((thresholds->>'notice')::numeric - 25, 0) then
      results := results || jsonb_build_array(
        jsonb_build_object(
          'person', case when p_lite then jsonb_build_object('id', r.id, 'reference_no', r.reference_no)
                        else fn_person_index_json(r) end,
          'person_detail', case when p_lite then null::jsonb else fn_person_json(r) end,
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

  -- Staging a big list is administrative bulk work; give the statement room
  -- instead of dying at the default statement timeout (field 2026-09-21).
  set local statement_timeout = '900s';

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
      matches := fn_check_person_duplicates(normres->'normalized', 1, null, true);
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


  update import_batches set total_rows = total_rows + inserted,
         new_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'OK'),
         duplicate_rows = (select count(*) from import_rows where batch_id = p_batch_id and match_score is not null),
         error_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'ERROR')
   where id = p_batch_id;

  return jsonb_build_object('ok', true, 'inserted', inserted);
end $$;

create or replace function fn_import_finalize_batch(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n int;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER');
  set local statement_timeout = '900s';

  -- ------------------------------------------------------------------
  -- In-file duplicate detection, once per batch (moved out of
  -- fn_import_add_rows on 2026-09-21: running it per staging chunk made
  -- the cost grow with the square of the rows staged so far and blew
  -- the statement timeout at LP-TOPAS scale).
  -- ------------------------------------------------------------------
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

  update import_batches set
         new_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'OK'),
         duplicate_rows = (select count(*) from import_rows where batch_id = p_batch_id and match_score is not null),
         error_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'ERROR')
   where id = p_batch_id;

  select count(*) into n from import_rows where batch_id = p_batch_id and 'DUPLICATE_IN_FILE' = any(issues);
  return jsonb_build_object('ok', true, 'in_file_duplicates', n);
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
  set local statement_timeout = '900s';
  insert into import_batches (file_name, mapping, created_by)
  values (coalesce(nullif(btrim(p_file_name),''), 'upload.csv'), p_mapping, actor.id)
  returning id into v_id;

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    perform fn_import_add_rows(v_id, p_rows);
  end if;

  return jsonb_build_object('ok', true, 'batch_id', v_id);
end $$;

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

  -- in-file duplicate flags are computed once for the whole batch here (and
  -- by fn_import_finalize_batch after staging), not per staging chunk
  perform fn_import_finalize_batch(p_batch_id);

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
