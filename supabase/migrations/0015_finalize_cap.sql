-- ---------------------------------------------------------------------
-- 0015: bound the in-file duplicate pass (field report 2026-09-21:
-- staging reached 386/386 and then the finalize pass itself hit the
-- statement timeout). The pair join is now capped at the 25 nearest
-- earlier candidates per row — linear in batch size — and the statement
-- gets half an hour of room instead of fifteen minutes.
-- ---------------------------------------------------------------------

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

  select count(*) into n from import_rows where batch_id = p_batch_id and 'DUPLICATE_IN_FILE' = any(issues);
  return jsonb_build_object('ok', true, 'in_file_duplicates', n);
end $$;
