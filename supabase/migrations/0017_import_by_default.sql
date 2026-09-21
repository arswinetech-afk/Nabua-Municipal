-- ---------------------------------------------------------------------
-- 0017: field directive 2026-09-21 (16:34): rows whose only flaw is a
-- missing contact detail, incomplete address or missing sex are to be
-- imported as-is and completed later by encoders. Only validation-blocked
-- rows and very-likely registry clashes keep waiting for a human.
--   * staging now defaults WARNING rows to IMPORT as well;
--   * bulk decisions gain an only-undecided scope so the review step can
--     normalise old batches without undoing manual Skip choices;
--   * batches already under review are normalised once, here.
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
                 else 'IMPORT' end);
    inserted := inserted + 1;
  end loop;


  update import_batches set total_rows = total_rows + inserted,
         new_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'OK'),
         duplicate_rows = (select count(*) from import_rows where batch_id = p_batch_id and match_score is not null),
         error_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'ERROR')
   where id = p_batch_id;

  return jsonb_build_object('ok', true, 'inserted', inserted);
end $$;

-- Bulk decisions: an extra scope so the review step can normalise whatever
-- is still undecided without undoing manual Skip/Import choices.
drop function if exists fn_import_set_all_decisions(uuid, text, text, boolean);
create or replace function fn_import_set_all_decisions(
  p_batch_id uuid, p_severity text, p_decision text,
  p_duplicates_only boolean default false, p_only_undecided boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');
  if p_decision not in ('PENDING','IMPORT','SKIP','LINK') then
    return jsonb_build_object('ok', false, 'error', 'Invalid decision.');
  end if;
  update import_rows set decision = p_decision
   where batch_id = p_batch_id and (p_severity is null or severity = p_severity)
     and not (p_decision = 'IMPORT'
              and (severity = 'ERROR' or coalesce(validation->>'band','') = 'VERY_LIKELY'))
     and (p_duplicates_only = false
          or 'DUPLICATE_IN_FILE' = any(issues)
          or match_score is not null)
     and (p_only_undecided = false or decision = 'PENDING');
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'updated', n);
end $$;


-- normalise batches still under review (manual decisions untouched)
update import_rows set decision = 'IMPORT'
 where decision = 'PENDING' and severity in ('OK', 'WARNING')
   and coalesce(validation->>'band','') <> 'VERY_LIKELY'
   and batch_id in (select id from import_batches where status <> 'IMPORTED');
