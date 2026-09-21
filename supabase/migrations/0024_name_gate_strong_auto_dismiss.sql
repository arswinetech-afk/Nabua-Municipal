-- ---------------------------------------------------------------------
-- 0024: field directive 2026-09-22 (01:40): the duplicate queue was
-- burning encoder time on the obvious. Strengthened name gate:
-- sharing a surname is NOT identity — unless the given name also
-- agrees (>=75% of the combined name weight), or the contact number /
-- identity key matches, the pair is capped at 30 and never queues.
--   * pending cases opened before this rule are auto-dismissed when
--     the gated score says 30 or less, with the reason recorded;
--   * fn_maintenance_trim_staging() lets an admin reclaim the staging
--     space of long-finished imports (import_rows is the biggest table
--     and the only one that grows without bound).
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
    if not contact_match and (s_last * wt_last + s_first * wt_first) < 0.75 * (wt_last + wt_first) then
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

-- clear the queue of cases the new gate says were never duplicates
update duplicate_cases c
   set status = 'DISMISSED',
       resolution = 'NAME_GATE_AUTO',
       reviewed_at = now(),
       reviewed_by_name = 'System (0024 name gate)',
       notes = coalesce(nullif(c.notes, ''),
         'Auto-dismissed: given names differ — shared surname, sex or address is not identity.'),
       updated_at = now()
  from persons pa, persons pb
 where c.status = 'PENDING'
   and c.person_id_a = pa.id and c.person_id_b = pb.id
   and (fn_score_pair(fn_person_json(pa), pb)->>'score')::numeric <= 30;

-- staging-space maintenance: drop rows of batches imported long ago
create or replace function fn_maintenance_trim_staging(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform fn_require_role('SYSTEM_ADMIN');
  delete from import_rows
   where batch_id in (select id from import_batches
                       where status = 'IMPORTED'
                         and committed_at < now() - make_interval(days => greatest(coalesce(p_days,30),1)));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'deleted_rows', n);
end $$;
