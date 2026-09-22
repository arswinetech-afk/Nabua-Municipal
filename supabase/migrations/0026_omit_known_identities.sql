-- ---------------------------------------------------------------------
-- 0026: field directive 2026-09-22 (11:41): "if names are exactly the
-- same or already in the system, the system can simply omit that" —
-- staging now skips any row whose identity key (first, middle, last,
-- suffix, birth date) matches a live registry person. Overlapping
-- lists (rice-subsidy rosters, re-uploads) stage only genuinely new
-- residents: no scoring, no review cards, no commit weight for people
-- the municipality already holds. The count is reported per batch
-- (import_batches.omitted_rows, fn_import_summary) and the wizard
-- tells the operator how many rows were omitted and why.
-- ---------------------------------------------------------------------

alter table import_batches add column if not exists omitted_rows int not null default 0;

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
         omitted_rows = coalesce(omitted_rows, 0) + omitted,
         new_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'OK'),
         duplicate_rows = (select count(*) from import_rows where batch_id = p_batch_id and match_score is not null),
         error_rows = (select count(*) from import_rows where batch_id = p_batch_id and severity = 'ERROR')
   where id = p_batch_id;

  return jsonb_build_object('ok', true, 'inserted', inserted, 'omitted', omitted);
end $$;

create or replace function fn_import_create_batch(
  p_file_name text,
  p_mapping jsonb default '{}'::jsonb,
  p_rows jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_id uuid;
  add_res jsonb;
begin
  perform fn_require_role('ADMINISTRATOR','SYSTEM_ADMIN');
  set local statement_timeout = '900s';
  insert into import_batches (file_name, mapping, created_by)
  values (coalesce(nullif(btrim(p_file_name),''), 'upload.csv'), p_mapping, actor.id)
  returning id into v_id;

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    add_res := fn_import_add_rows(v_id, p_rows);
  end if;

  return jsonb_build_object('ok', true, 'batch_id', v_id,
    'omitted', coalesce((add_res->>'omitted')::int, 0));
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
    'omitted_rows', coalesce(b.omitted_rows, 0),
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
