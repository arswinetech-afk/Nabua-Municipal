-- ---------------------------------------------------------------------
-- 0022: field reports 2026-09-21 21:55.
-- (a) The commit timed out again because fn_create_person re-checks every
--     row against the registry in FULL mode: up to 400 candidates, each
--     materialised as complete person JSON. Now that the registry holds
--     whole surname clusters, that is seconds per row. The commit now
--     asks for the lite check (50 capped candidates, minimal JSON) — the
--     same check staging uses — via a new fn_create_person flag.
-- (b) Duplicate Centre was surfacing pairs that share only sex / address /
--     barangay / birth date while the names clearly differ (max such score
--     is 44-52, above the queue floor of 35). The scorer now caps any pair
--     whose surname AND given name both disagree — without a contact or
--     identity-key match — at 30, below every queue and band threshold.
-- ---------------------------------------------------------------------

create or replace function fn_score_json(
  c jsonb,
  e jsonb,
  p_weights jsonb default null,
  p_thresholds jsonb default null)
returns jsonb language plpgsql stable as $$
declare
  w jsonb := coalesce(p_weights, fn_duplicate_weights());
  th jsonb := coalesce(p_thresholds, fn_duplicate_thresholds());
  wt_last numeric := coalesce((w->>'last_name')::numeric, 26);
  wt_first numeric := coalesce((w->>'first_name')::numeric, 22);
  wt_mid numeric := coalesce((w->>'middle_name')::numeric, 8);
  wt_dob numeric := coalesce((w->>'date_of_birth')::numeric, 20);
  wt_sex numeric := coalesce((w->>'sex')::numeric, 5);
  wt_brgy numeric := coalesce((w->>'barangay')::numeric, 6);
  wt_addr numeric := coalesce((w->>'address')::numeric, 8);
  wt_contact numeric := coalesce((w->>'contact')::numeric, 5);

  c_last text := fn_norm_name(c->>'last_name');
  c_first text := fn_norm_name(c->>'first_name');
  c_mid text := fn_norm_name(c->>'middle_name');
  c_sex text := fn_norm_text(c->>'sex');
  c_dob date := fn_norm_date(c->>'date_of_birth');
  c_key text := fn_identity_key(c->>'first_name', c->>'middle_name', c->>'last_name', c->>'suffix', c_dob);
  c_contact text := fn_norm_contact(c->>'contact_number');
  c_brgy text := fn_norm_text(coalesce(c->>'barangay_name', c->>'barangay', ''));
  c_addr text := fn_norm_text(coalesce(c->>'purok','') || ' ' || coalesce(c->>'address',''));

  e_last text := fn_norm_name(e->>'last_name');
  e_first text := fn_norm_name(e->>'first_name');
  e_mid text := fn_norm_name(e->>'middle_name');
  e_sex text := fn_norm_text(e->>'sex');
  e_dob date := fn_norm_date(e->>'date_of_birth');
  e_key text := coalesce(nullif(e->>'identity_key',''),
                         fn_identity_key(e->>'first_name', e->>'middle_name', e->>'last_name', e->>'suffix', e_dob));
  e_contact text := coalesce(nullif(fn_norm_contact(e->>'contact_number'), ''), fn_norm_contact(e->>'contact_search'));
  e_brgy text := fn_norm_text(coalesce(e->>'barangay_name', ''));
  e_addr text := fn_norm_text(coalesce(e->>'purok','') || ' ' || coalesce(e->>'address',''));
  e_status text := coalesce(e->>'status', 'ACTIVE');

  j_last jsonb; j_first jsonb; j_mid jsonb;
  s_last numeric; s_first numeric; s_mid numeric;
  s_dob numeric; dob_unknown boolean; dob_conflict boolean;
  sex_unknown boolean; sex_conflict boolean; s_sex numeric;
  s_brgy numeric; s_addr numeric;
  contact_match boolean; contact_both boolean; contact_unknown boolean; s_contact numeric;

  total numeric := 0; score numeric;
  reasons jsonb := '[]'::jsonb;
  flags jsonb;
  identity_match boolean;
  capped text := '';
begin
  if e_status = 'ARCHIVED' or (e->>'merged_into') is not null then
    return jsonb_build_object('score', 0, 'band', 'DISTINCT', 'reasons', '[]'::jsonb,
                              'matched_fields', '[]'::jsonb, 'flags', '{"skipped":true}'::jsonb);
  end if;

  identity_match := (c_key <> '||||' and c_key = e_key and c_dob is not null and c_last <> '');

  j_last  := fn_name_similarity(c->>'last_name',  e_last);
  j_first := fn_name_similarity(c->>'first_name', e_first);
  j_mid   := fn_name_similarity(c->>'middle_name', e_mid);
  s_last  := (j_last->>'score')::numeric;
  s_first := (j_first->>'score')::numeric;
  s_mid   := (j_mid->>'score')::numeric;

  dob_unknown := (c_dob is null or e_dob is null);
  dob_conflict := (c_dob is not null and e_dob is not null and c_dob <> e_dob);
  s_dob := case when dob_unknown then 0.45 when dob_conflict then 0 when c_dob = e_dob then 1 else 0.45 end;
  if c_dob is not null and e_dob is not null and c_dob = e_dob then
    s_dob := 1;
  end if;

  sex_unknown := (c_sex = '' or e_sex = '' or c_sex = 'UNKNOWN');
  sex_conflict := (not sex_unknown and c_sex <> e_sex);
  s_sex := case when sex_unknown then 0.5 when sex_conflict then 0 else 1 end;

  s_brgy := case
              when c_brgy = '' or e_brgy = '' then 0.5
              when c_brgy = e_brgy then 1
              else 0 end;

  s_addr := case
              when c_addr = '' or e_addr = '' then 0.5
              else greatest(fn_similarity(c_addr, e_addr), fn_token_similarity(c_addr, e_addr))
            end;

  contact_match := (c_contact <> '' and e_contact <> '' and c_contact = e_contact and length(c_contact) >= 7);
  contact_both := (c_contact <> '' and e_contact <> '');
  contact_unknown := (c_contact = '' or e_contact = '');
  s_contact := case when contact_unknown then 0.5 when contact_match then 1 else 0.15 end;

  total := s_last*wt_last + s_first*wt_first + s_mid*wt_mid + s_dob*wt_dob
         + s_sex*wt_sex + s_brgy*wt_brgy + s_addr*wt_addr + s_contact*wt_contact;

  if identity_match then
    score := 100;
  else
    score := total;
    if contact_match then score := score + 8; end if;
    if contact_both and not contact_match then score := score * 0.96; end if;
    if dob_conflict then
      score := score * 0.75;
      score := least(score, 74);
      if s_last >= 0.95 and s_first >= 0.95 then score := greatest(score, 62); end if;
      capped := 'date_of_birth_conflict';
    end if;
    if sex_conflict then
      score := score * 0.65;
      score := least(score, 84);
      capped := case when capped = '' then 'sex_conflict' else capped || ',sex_conflict' end;
    end if;
    -- 0022 field directive: shared sex / address / barangay / birth date must
    -- never surface as a duplicate when the names are clearly different.
    -- Without a contact-number match or an identity-key match, a pair whose
    -- surname and given name both disagree is capped far below the queue
    -- floor (notice - 25 = 35), so it never reaches the Duplicate Centre.
    if not contact_match and (s_last * wt_last + s_first * wt_first) < 0.5 * (wt_last + wt_first) then
      score := least(score, 30);
      capped := case when capped = '' then 'name_mismatch' else capped || ',name_mismatch' end;
    end if;
    if dob_unknown and not dob_conflict then
      score := least(score, 88);
      capped := case when capped = '' then 'date_of_birth_unknown' else capped || ',date_of_birth_unknown' end;
    end if;
  end if;

  score := round(greatest(least(score, 100), 0), 2);

  reasons := jsonb_build_array(
    fn_reason('last_name','Last name', s_last, wt_last, c->>'last_name', e->>'last_name', j_last, false, false),
    fn_reason('first_name','First name', s_first, wt_first, c->>'first_name', e->>'first_name', j_first, false, false),
    fn_reason('middle_name','Middle name', s_mid, wt_mid, c->>'middle_name', e->>'middle_name', j_mid,
              (c_mid = '' or e_mid = ''), false),
    fn_reason('date_of_birth','Date of birth', s_dob, wt_dob, c->>'date_of_birth', e_dob::text,
              jsonb_build_object('score', s_dob, 'reason', case when dob_unknown then 'unknown' else 'exact' end),
              dob_unknown, dob_conflict),
    fn_reason('sex','Sex', s_sex, wt_sex, c->>'sex', e->>'sex',
              jsonb_build_object('score', s_sex, 'reason', case when sex_unknown then 'unknown' else 'exact' end),
              sex_unknown, sex_conflict),
    fn_reason('barangay','Barangay', s_brgy, wt_brgy, c_brgy, e->>'barangay_name',
              jsonb_build_object('score', s_brgy, 'reason', case when s_brgy = 1 then 'exact' else 'mismatch' end),
              (c_brgy = '' or e_brgy = ''), false),
    fn_reason('address','Address / Purok', s_addr, wt_addr, c_addr, e_addr,
              jsonb_build_object('score', s_addr, 'reason', case when s_addr >= 0.9 then 'near' else 'partial' end),
              (c_addr = '' or e_addr = ''), false),
    fn_reason('contact_number','Contact number', s_contact, wt_contact, c_contact, e_contact,
              jsonb_build_object('score', s_contact, 'reason', case when contact_match then 'exact' else 'mismatch' end),
              contact_unknown, false)
  );

  flags := jsonb_build_object(
    'identityMatch', identity_match,
    'dobConflict', dob_conflict,
    'sexConflict', sex_conflict,
    'dobUnknown', dob_unknown,
    'contactMatch', contact_match,
    'nameOnlyMatch', (s_last >= 0.95 and s_first >= 0.95 and (dob_conflict or dob_unknown)),
    'cappedBy', nullif(capped, '')
  );

  return jsonb_build_object(
    'score', score,
    'band', fn_band_for(score, th)::text,
    'reasons', reasons,
    'matched_fields', coalesce((select jsonb_agg(r->>'field') from jsonb_array_elements(reasons) r
                                where r->>'status' = 'match'), '[]'::jsonb),
    'flags', flags
  );
end $$;

-- single signature only: drop the 3-arg form first so 1-3 arg calls
-- (there are many) never face an ambiguous overload
drop function if exists fn_create_person(jsonb, boolean, text);

create or replace function fn_create_person(
  p jsonb,
  p_confirmed_distinct boolean default false,
  p_reason text default null,
  p_lite_duplicate_check boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_id uuid;
  v_new persons;
  v_dup jsonb;
  v_client_ref uuid := nullif(p->>'client_ref','')::uuid;
  v_band text;
  v_household uuid;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN');

  -- offline sync replay must be idempotent
  if v_client_ref is not null then
    select * into v_new from persons where client_ref = v_client_ref;
    if found then
      return jsonb_build_object('ok', true, 'replayed', true, 'person', fn_person_json(v_new));
    end if;
  end if;

  -- server-side validation (never trust the browser)
  if coalesce(btrim(p->>'first_name'),'') = '' or coalesce(btrim(p->>'last_name'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'First name and last name are required.',
                              'code', 'VALIDATION');
  end if;
  if (p->>'date_of_birth') is not null and fn_norm_date(p->>'date_of_birth') is null then
    return jsonb_build_object('ok', false, 'error', 'Date of birth is not a valid date.', 'code', 'VALIDATION');
  end if;
  if coalesce(p->>'sex','') not in ('', 'MALE', 'FEMALE') then
    return jsonb_build_object('ok', false, 'error', 'Sex must be MALE or FEMALE.', 'code', 'VALIDATION');
  end if;

  -- Paper lists (e.g. LP-TOPAS) number families. Resolve the household or
  -- create it once, so family grouping from the list survives the import.
  if coalesce(btrim(p->>'household_no'),'') <> '' and nullif(p->>'barangay_id','') is not null then
    select id into v_household from households where household_no = btrim(p->>'household_no');
    if not found then
      insert into households (household_no, barangay_id, created_at, updated_at)
      values (btrim(p->>'household_no'), nullif(p->>'barangay_id','')::uuid, now(), now())
      returning id into v_household;
    end if;
  end if;

  v_dup := fn_check_person_duplicates(p, 5, null, p_lite_duplicate_check);
  v_band := coalesce(v_dup->0->>'band', 'DISTINCT');

  if not p_confirmed_distinct and v_band = 'VERY_LIKELY'
     and coalesce((fn_setting('system','{}'::jsonb)->>'block_on_very_likely')::boolean, true) then
    return jsonb_build_object(
      'ok', false, 'code', 'DUPLICATE_REVIEW_REQUIRED',
      'band', v_band, 'matches', v_dup,
      'error', 'Very likely duplicate. Review the existing record before continuing.');
  end if;

  if p_confirmed_distinct then
    perform fn_set_duplicate_override(true);
    perform set_config('nmbr.audit_reason', coalesce(p_reason, 'Declared as a different person after duplicate review'), true);
  end if;

  insert into persons (
    first_name, middle_name, last_name, suffix, date_of_birth, sex, civil_status,
    contact_number, address, purok, barangay_id, status, remarks, household_id,
    client_ref, created_by, updated_by, classification_code,
    tags, occupation)
  values (
    p->>'first_name', nullif(p->>'middle_name',''), p->>'last_name', nullif(p->>'suffix',''),
    fn_norm_date(p->>'date_of_birth'), nullif(p->>'sex',''), nullif(p->>'civil_status',''),
    nullif(p->>'contact_number',''), nullif(p->>'address',''), nullif(p->>'purok',''),
    nullif(p->>'barangay_id','')::uuid,
    coalesce(nullif(p->>'status',''), 'ACTIVE')::person_status,
    nullif(p->>'remarks',''), coalesce(v_household, nullif(p->>'household_id','')::uuid),
    v_client_ref, actor.id, actor.id, nullif(p->>'classification_code',''),
    fn_parse_tags(p->'tags'), nullif(p->>'occupation',''))
  returning * into v_new;

  -- start barangay history
  if v_new.barangay_id is not null then
    insert into member_barangay_history (person_id, barangay_id, effective_from, status, reason, created_by)
    values (v_new.id, v_new.barangay_id, current_date, 'ACTIVE', 'RESIDENT_TRANSFER', actor.id);
  end if;

  perform fn_set_duplicate_override(false);

  -- queue near-miss matches for review so nothing is lost
  if v_band in ('POSSIBLE','POTENTIAL') then
    declare m jsonb;
    begin
      for m in select * from jsonb_array_elements(v_dup) loop
        if (m->>'score')::numeric >= (fn_duplicate_thresholds()->>'warn')::numeric then
          insert into duplicate_cases (person_id_a, person_id_b, match_score, match_band,
                                       matching_fields, matched_details, status, source, created_by)
          values ((m->'person'->>'id')::uuid, v_new.id, (m->>'score')::numeric,
                  (m->>'band')::match_band,
                  array(select jsonb_array_elements_text(m->'matched_fields')),
                  m, 'PENDING', 'LIVE_CHECK', actor.id)
          on conflict do nothing;
        end if;
      end loop;
    end;
  end if;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role, 'CREATED', 'PERSONS', v_new.id,
          concat_ws(' ', v_new.first_name, v_new.last_name), fn_person_json(v_new), array['record'],
          p_reason, fn_session_info());

  return jsonb_build_object('ok', true, 'person', fn_person_json(v_new),
                            'matches', v_dup, 'band', v_band);
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
