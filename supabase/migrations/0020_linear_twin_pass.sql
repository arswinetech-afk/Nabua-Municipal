-- ---------------------------------------------------------------------
-- 0020: the in-file twin pass goes linear (field reports 20:16/20:17:
-- staging 813/813 ended with "Staged with a caveat", then the commit
-- died re-running the same pass). The 0015 pass capped SCORING at 25
-- candidates per row but still MATERIALIZED the whole blocked self
-- join — on a sheet where one surname covers hundreds of rows that
-- join is quadratic and no cap saves it. Detection is now two grouped
-- passes (same surname + birth date, or same surname + contact
-- number): no self join at all, milliseconds at any list size. Fuzzy
-- typo variants inside one file are no longer pre-flagged; they are
-- still caught at commit, where every row is re-checked against the
-- live registry and parked as a duplicate case instead of imported.
-- ---------------------------------------------------------------------

create or replace function fn_import_finalize_batch(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n int;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN','ENCODER');
  set local statement_timeout = '1800s';

  -- pass 1: identical surname block + birth date inside the same file
  update import_rows ir
     set issues = array(select distinct unnest(ir.issues || array['DUPLICATE_IN_FILE'])),
         severity = case when ir.severity = 'ERROR' then 'ERROR' else 'WARNING' end,
         validation = ir.validation || jsonb_build_object(
           'in_file_score', 100, 'in_file_duplicate', true,
           'in_file_details', jsonb_build_object(
             'reason', 'same surname and birth date as row ' || k.first_row::text,
             'row_of_record', k.first_row))
    from (select id, row_no,
                 min(row_no) over (partition by validation->>'block_last', validation->>'block_dob') as first_row,
                 count(*)  over (partition by validation->>'block_last', validation->>'block_dob') as grp
            from import_rows
           where batch_id = p_batch_id
             and nullif(validation->>'block_last', '') is not null
             and nullif(validation->>'block_dob', '') is not null) k
   where k.id = ir.id and k.grp > 1 and k.row_no > k.first_row
     and not ('DUPLICATE_IN_FILE' = any(ir.issues));

  -- pass 2: identical surname block + contact number (twins without dob)
  update import_rows ir
     set issues = array(select distinct unnest(ir.issues || array['DUPLICATE_IN_FILE'])),
         severity = case when ir.severity = 'ERROR' then 'ERROR' else 'WARNING' end,
         validation = ir.validation || jsonb_build_object(
           'in_file_score', 100, 'in_file_duplicate', true,
           'in_file_details', jsonb_build_object(
             'reason', 'same surname and contact number as row ' || k.first_row::text,
             'row_of_record', k.first_row))
    from (select id, row_no,
                 min(row_no) over (partition by validation->>'block_last', validation->>'block_contact') as first_row,
                 count(*)  over (partition by validation->>'block_last', validation->>'block_contact') as grp
            from import_rows
           where batch_id = p_batch_id
             and nullif(validation->>'block_last', '') is not null
             and nullif(validation->>'block_contact', '') is not null) k
   where k.id = ir.id and k.grp > 1 and k.row_no > k.first_row
     and not ('DUPLICATE_IN_FILE' = any(ir.issues));

  update import_batches set
         new_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'OK'),
         duplicate_rows = (select count(*) from import_rows where batch_id = p_batch_id and match_score is not null),
         error_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'ERROR'),
         finalized_at = now()
   where id = p_batch_id;

  select count(*) into n from import_rows where batch_id = p_batch_id and 'DUPLICATE_IN_FILE' = any(issues);
  return jsonb_build_object('ok', true, 'in_file_duplicates', n);
end $$;

-- the batch staged under the old pass (caveat at 20:16) gets its twin
-- flags now, inline, without needing a signed-in session
update import_rows ir
   set issues = array(select distinct unnest(ir.issues || array['DUPLICATE_IN_FILE'])),
       severity = case when ir.severity = 'ERROR' then 'ERROR' else 'WARNING' end,
       validation = ir.validation || jsonb_build_object(
         'in_file_score', 100, 'in_file_duplicate', true,
         'in_file_details', jsonb_build_object(
           'reason', 'same surname and birth date as row ' || k.first_row::text,
           'row_of_record', k.first_row))
  from (select id, row_no, batch_id,
               min(row_no) over (partition by batch_id, validation->>'block_last', validation->>'block_dob') as first_row,
               count(*)  over (partition by batch_id, validation->>'block_last', validation->>'block_dob') as grp
          from import_rows
         where nullif(validation->>'block_last', '') is not null
           and nullif(validation->>'block_dob', '') is not null) k
  join import_batches b on b.id = k.batch_id
 where k.id = ir.id and k.grp > 1 and k.row_no > k.first_row
   and b.status <> 'IMPORTED' and b.finalized_at is null
   and not ('DUPLICATE_IN_FILE' = any(ir.issues));

update import_batches set finalized_at = now()
 where finalized_at is null;
