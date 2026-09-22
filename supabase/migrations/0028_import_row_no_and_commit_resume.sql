-- ---------------------------------------------------------------------
-- 0028: field report 2026-09-22 13:42 (rice-subsidy list, 3,088 rows).
--
-- (1) The review list showed the same row number on every line ("1",
--     then "8"). Staging uploads in chunks, and import_rows.row_no was
--     the position inside each chunk — so the list grouped the 1st row
--     of every chunk together, then the 2nd of every chunk, and so on.
--     fn_import_add_rows now stores the TRUE Excel row the importer
--     sends (__fileRow), falling back to the chunk position when an old
--     client does not send it.
--
-- (2) The commit statement was cancelled by statement_timeout on a
--     3,085-row approve. The browser client now halves its chunk and
--     resumes automatically (commit is resumable since 0018); this
--     migration also re-creates fn_import_commit from 0022 so every
--     database gets the 30-minute statement budget and the lite
--     per-row duplicate gate in one place.
-- ---------------------------------------------------------------------

create or replace function fn_import_add_rows(p_batch_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  b import_batches;
  r jsonb;
  normres jsonb;
  idx int := 0;
  inserted int := 0;
  omitted int := 0;
  dob_stripped boolean;
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

    -- 0021: Excel-epoch junk (1899-12-30) and future dates can never satisfy
    -- persons_dob_sane. Drop them here with a visible chip instead of letting
    -- the commit discover the constraint one chunk at a time.
    dob_stripped := (normres->'normalized'->>'date_of_birth') ~ '^\d{4}-\d{2}-\d{2}$'
      and ((normres->'normalized'->>'date_of_birth')::date <= '1900-01-01'
           or (normres->'normalized'->>'date_of_birth')::date >= (now()::date + 1));
    if dob_stripped then
      normres := jsonb_set(normres, '{normalized}', (normres->'normalized') - 'date_of_birth');
      normres := jsonb_set(normres, '{issues}', (normres->'issues') || '["IMPLAUSIBLE_DOB"]'::jsonb);
    end if;

    issues := normres->'issues';
    sev := normres->>'severity';
    if dob_stripped then
      sev := case when sev = 'ERROR' then 'ERROR' else 'WARNING' end;
    end if;

    seen_key := fn_identity_key(normres->'normalized'->>'first_name', normres->'normalized'->>'middle_name',
                                normres->'normalized'->>'last_name', normres->'normalized'->>'suffix',
                                (normres->'normalized'->>'date_of_birth')::date);

    if seen_key <> '||||' and seen_key = any(seen_keys) then
      issues := issues || '["DUPLICATE_IN_FILE"]'::jsonb;
      sev := case when sev = 'ERROR' then 'ERROR' else 'WARNING' end;
    elsif seen_key <> '||||' then
      seen_keys := seen_keys || seen_key;
    end if;

    -- 0026 field directive: a row whose identity (names + birth date) already
    -- exists in the registry is omitted at staging — never scored, never
    -- reviewed, never re-imported. Cuts overlapping lists (subsidy rosters)
    -- down to only the residents the registry does not yet have.
    if seen_key <> '||||' and exists (select 1 from persons p
                                       where p.identity_key = seen_key
                                         and p.merged_into is null
                                         and p.status <> 'ARCHIVED') then
      omitted := omitted + 1;
      continue;
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
    values (p_batch_id, coalesce((r->>'__fileRow')::int, idx), r, normres->'normalized',
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
                 else 'IMPORT' end);
    inserted := inserted + 1;
  end loop;


  update import_batches set total_rows = total_rows + inserted,
         omitted_rows = coalesce(omitted_rows, 0) + omitted,
         new_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'OK'),
         duplicate_rows = (select count(*) from import_rows where batch_id = p_batch_id and match_score is not null),
         error_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'ERROR')
   where id = p_batch_id;

  return jsonb_build_object('ok', true, 'inserted', inserted, 'omitted', omitted);
end $$;

create or replace function fn_import_commit(
  p_batch_id uuid, p_default_barangay uuid default null, p_max_rows int default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  b import_batches;
  r record;
  imported int := 0;
  skipped int := 0;
  linked int := 0;
  dupes int := 0;
  remaining int;
  tot_imported int;
  tot_parked int;
  tot_skipped int;
  dup_result jsonb;
  dob_stripped boolean := false;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');
  set local statement_timeout = '1800s';

  select * into b from import_batches where id = p_batch_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Import batch not found.');
  end if;
  if b.status = 'IMPORTED' then
    return jsonb_build_object('ok', false, 'error', 'This batch was already imported.');
  end if;

  -- 0019: the commit no longer re-runs finalize. Staging already scored
  -- every row; re-scoring inside the commit statement is what timed out
  -- at LP-TOPAS scale (field reports 19:34 and 19:57). Batches staged
  -- before finalized_at existed are backfilled at the bottom of this
  -- migration, so they commit without a re-score as well.
  if b.finalized_at is null then
    perform fn_import_finalize_batch(p_batch_id);
  end if;

  for r in select * from import_rows
            where batch_id = p_batch_id and decision = 'IMPORT'
              and severity <> 'ERROR' and imported_person_id is null
            order by row_no
            limit coalesce(p_max_rows, 1000000)
  loop
    dob_stripped := false;
    -- final live duplicate check per row (registry may have changed since staging)
    begin
      dup_result := fn_create_person(
        r.normalized || jsonb_build_object('barangay_id', coalesce(r.normalized->>'barangay_id', p_default_barangay::text)),
        false, 'Bulk import: ' || b.file_name, true);
    exception when others then
      -- 0021: one bad row must never kill a chunk. Retry once without an
      -- implausible birth date; if that still fails, park the row with the
      -- constraint message instead of aborting 60 good rows.
      if r.normalized ? 'date_of_birth' then
        begin
          dup_result := fn_create_person(
            (r.normalized - 'date_of_birth')
              || jsonb_build_object('barangay_id', coalesce(r.normalized->>'barangay_id', p_default_barangay::text)),
            false, 'Bulk import: ' || b.file_name, true);
          dob_stripped := true;
        exception when others then
          dup_result := jsonb_build_object('ok', false, 'error', SQLERRM);
        end;
      else
        dup_result := jsonb_build_object('ok', false, 'error', SQLERRM);
      end if;
    end;

    if coalesce((dup_result->>'ok')::boolean, false) then
      update import_rows set imported_person_id = (dup_result->'person'->>'id')::uuid, decision = 'IMPORT',
             issues = case when dob_stripped
                           then array(select distinct unnest(issues || array['IMPLAUSIBLE_DOB']))
                           else issues end,
             validation = case when dob_stripped
                           then validation || jsonb_build_object('dob_removed', r.normalized->>'date_of_birth')
                           else validation end
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
      dupes := dupes + 1;
    else
      update import_rows set decision = 'SKIP', validation = validation || jsonb_build_object('error', dup_result->>'error')
       where id = r.id;
      skipped := skipped + 1;
    end if;
  end loop;

  remaining := (select count(*) from import_rows
                 where batch_id = p_batch_id and decision = 'IMPORT'
                   and severity <> 'ERROR' and imported_person_id is null);

  if remaining = 0 then
    linked := (select count(*) from import_rows where batch_id = p_batch_id and decision = 'LINK');
    tot_imported := (select count(*) from import_rows where batch_id = p_batch_id and imported_person_id is not null);
    tot_parked := (select count(*) from import_rows where batch_id = p_batch_id
                    and coalesce((validation->>'parked_for_review')::boolean, false));
    tot_skipped := (select count(*) from import_rows where batch_id = p_batch_id
                     and decision = 'SKIP' and validation ? 'error');

    update import_batches
       set status = 'IMPORTED', imported_rows = tot_imported, committed_at = now()
     where id = p_batch_id;

    insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                            new_values, reason, session_info)
    values (actor.id, actor.name, actor.role, 'IMPORTED', 'IMPORT_BATCH', p_batch_id, b.file_name,
            jsonb_build_object('imported', tot_imported, 'duplicates_parked', tot_parked,
                               'skipped', tot_skipped, 'linked_to_existing', linked),
            'Bulk import committed', fn_session_info());
  end if;

  return jsonb_build_object('ok', true, 'imported', imported, 'duplicates_parked', dupes,
    'skipped', skipped, 'linked', linked, 'remaining', remaining, 'done', remaining = 0,
    'message', imported || ' record(s) imported in this step; ' || remaining || ' still to go.');
end $$;
