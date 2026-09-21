-- ---------------------------------------------------------------------
-- 0019: commit timeouts, round two (field reports 2026-09-21 19:34 and
-- 19:57). The chunked commit of 0018 still re-ran the whole finalize
-- pass inside its first chunk; at LP-TOPAS scale that single re-score
-- eats the statement budget before a single row is written. Finalize
-- now stamps import_batches.finalized_at and the commit only scores a
-- batch that was never finalized. Each commit chunk also gets a
-- 30-minute statement budget instead of 15.
-- ---------------------------------------------------------------------

alter table import_batches add column if not exists finalized_at timestamptz;

create or replace function fn_import_finalize_batch(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n int;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER');
  set local statement_timeout = '1800s';

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
  with pairs as (
    select cur.id as cur_id, cur.normalized as cur_norm, prev.normalized as prev_norm,
           row_number() over (partition by cur.id order by prev.row_no desc) as rn
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
  candidates as (
    -- cap: score only the 25 nearest earlier candidates per row. Without a
    -- cap a barangay list full of one surname makes the pair count (and the
    -- runtime) explode — field report 2026-09-21, finalize timeout at 386 rows.
    select cur_id as dup_id, fn_score_json(cur_norm, prev_norm, null, null) as sc
      from pairs
     where rn <= 25
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

  update import_batches set finalized_at = now() where id = p_batch_id;

  select count(*) into n from import_rows where batch_id = p_batch_id and 'DUPLICATE_IN_FILE' = any(issues);
  return jsonb_build_object('ok', true, 'in_file_duplicates', n);
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

-- every batch that exists today was finalized while staging
update import_batches set finalized_at = coalesce(committed_at, now())
 where finalized_at is null;
