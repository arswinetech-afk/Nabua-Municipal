-- ---------------------------------------------------------------------
-- 0018: the commit step joins the chunked club (field report 2026-09-21
-- 19:34: "Import 741 approved row(s)" died on a statement timeout).
-- fn_import_commit now processes at most p_max_rows rows per call and
-- reports how many remain; the client calls it repeatedly until done.
-- Every chunk is its own transaction, so a timeout can never lose work:
-- tapping Import again resumes exactly where it stopped. The expensive
-- finalize pass runs only on the first chunk, and the batch is closed
-- (status IMPORTED + audit row) only when nothing remains.
-- ---------------------------------------------------------------------

drop function if exists fn_import_commit(uuid, uuid);
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
  set local statement_timeout = '900s';

  select * into b from import_batches where id = p_batch_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Import batch not found.');
  end if;
  if b.status = 'IMPORTED' then
    return jsonb_build_object('ok', false, 'error', 'This batch was already imported.');
  end if;

  -- match scoring refresh happens once, on the first chunk of the commit
  if not exists (select 1 from import_rows
                  where batch_id = p_batch_id and imported_person_id is not null) then
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
