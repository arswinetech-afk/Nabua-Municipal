-- =====================================================================
-- NMBR — 0002_functions.sql
-- Normalisation, fuzzy similarity and duplicate scoring.
--
-- The logic here is intentionally a mirror of src/lib/duplicateEngine.ts so
-- that the offline (browser) check and the authoritative (database) check
-- produce the same verdict. Change one, change the other.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Normalisation
-- ---------------------------------------------------------------------
create or replace function fn_norm_text(t text)
returns text language sql immutable parallel safe as $$
  select coalesce(
    nullif(
      btrim(
        regexp_replace(
          upper(translate(coalesce(t,''),
            'áàâãäåéèêëíìîïóòôõöúùûüñçÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
            'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC')),
          '[^A-Z0-9]+', ' ', 'g')),
      ''),
    '')
$$;

create or replace function fn_norm_name(t text)
returns text language sql immutable parallel safe as $$ select fn_norm_text(t) $$;

create or replace function fn_norm_digits(t text)
returns text language sql immutable parallel safe as $$
  select coalesce(regexp_replace(coalesce(t,''), '[^0-9]+', '', 'g'), '')
$$;

-- PH contact normalisation: 09171234567, +63 917 123 4567, 639171234567 -> 9171234567
create or replace function fn_norm_contact(t text)
returns text language sql immutable parallel safe as $$
  with d as (select fn_norm_digits(t) as digits)
  select case
    when digits = '' then ''
    when length(digits) > 10 and left(digits, 2) = '63' then substring(digits from 3)
    when left(digits, 1) = '0' then substring(digits from 2)
    else digits
  end from d
$$;

-- Accepts ISO, PH (01/12/1985) and most human formats. Returns null when unusable.
create or replace function fn_norm_date(t text)
returns date language plpgsql immutable as $$
declare
  s text := btrim(coalesce(t,''));
  m text[];
  a int; b int; y int; tmp int;
begin
  if s = '' then return null; end if;
  if s ~ '^\d{4}-\d{1,2}-\d{1,2}' then
    begin return substring(s from 1 for 10)::date; exception when others then return null; end;
  end if;
  m := regexp_match(s, '^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$');
  if m is not null then
    a := m[1]::int; b := m[2]::int; y := m[3]::int;
    if y < 100 then y := y + case when y > 30 then 1900 else 2000 end; end if;
    if a > 12 and b <= 12 then tmp := a; a := b; b := tmp; end if;
    if a < 1 or a > 12 or b < 1 or b > 31 then return null; end if;
    begin
      return make_date(y, a, b);
    exception when others then
      return null;
    end;
  end if;
  begin
    return s::timestamptz::date;
  exception when others then
    return null;
  end;
end $$;

-- Deterministic identity key. MUST stay identical to identityKey() in TypeScript.
create or replace function fn_identity_key(
  p_first text, p_middle text, p_last text, p_suffix text, p_dob date)
returns text language sql immutable parallel safe as $$
  select concat_ws('|',
    fn_norm_name(p_last),
    fn_norm_name(p_first),
    fn_norm_name(p_middle),
    fn_norm_name(p_suffix),
    coalesce(p_dob::text, ''))
$$;

-- ---------------------------------------------------------------------
-- Similarity primitives (no extensions required — pg_trgm is optional)
-- ---------------------------------------------------------------------
create or replace function fn_bigrams(t text)
returns text[] language sql immutable parallel safe as $$
  select coalesce(array_agg(substring(' ' || t || ' ' from i for 2)), '{}'::text[])
  from generate_series(1, greatest(length(' ' || t || ' ') - 1, 0)) as i
$$;

-- Dice coefficient over character bigrams (same family as pg_trgm similarity())
create or replace function fn_similarity(a text, b text)
returns numeric language plpgsql immutable as $$
declare
  ga text[]; gb text[]; matches int := 0; i int; j int; used boolean[];
begin
  a := coalesce(a,''); b := coalesce(b,'');
  if a = '' or b = '' then return 0; end if;
  if a = b then return 1; end if;
  ga := fn_bigrams(a); gb := fn_bigrams(b);
  used := array_fill(false, array[array_length(gb,1)]);
  for i in 1 .. coalesce(array_length(ga,1),0) loop
    for j in 1 .. coalesce(array_length(gb,1),0) loop
      if not used[j] and ga[i] = gb[j] then
        used[j] := true; matches := matches + 1; exit;
      end if;
    end loop;
  end loop;
  return round((2.0 * matches) / (array_length(ga,1) + array_length(gb,1))::numeric, 4);
end $$;

-- Token-set similarity with a containment bonus:
-- 'JUAN CRUZ' vs 'JUAN SANTOS CRUZ' must score high (incomplete middle name case).
create or replace function fn_token_similarity(a text, b text)
returns numeric language plpgsql immutable as $$
declare
  ta text[]; tb text[]; inter int := 0; union_n int; t text;
begin
  a := coalesce(a,''); b := coalesce(b,'');
  if a = '' or b = '' then return 0; end if;
  if a = b then return 1; end if;
  ta := string_to_array(a, ' '); tb := string_to_array(b, ' ');
  foreach t in array ta loop
    if t = any(tb) then inter := inter + 1; end if;
  end loop;
  if inter = 0 then return 0; end if;
  union_n := array_length(ta,1) + array_length(tb,1) - inter;
  return greatest(
    round(inter::numeric / greatest(union_n,1), 4),
    case when inter = least(array_length(ta,1), array_length(tb,1)) then 0.85 else 0 end
  );
end $$;

-- Lightweight phonetic key (survives common Filipino name spelling variants)
create or replace function fn_phonetic(t text)
returns text language plpgsql immutable as $$
declare
  words text[]; w text; out_parts text[] := '{}'; x text;
begin
  t := fn_norm_text(t);
  if t = '' then return ''; end if;
  words := string_to_array(t, ' ');
  foreach w in array words loop
    x := w;
    x := regexp_replace(x, '^(KN|GN|PN|WR|PS)', '\1');
    x := regexp_replace(x, '^X', 'S');
    x := regexp_replace(x, 'C(Q|E|I|Y)', 'S');
    x := regexp_replace(x, 'PH', 'F');
    x := regexp_replace(x, 'GH', 'H');
    x := regexp_replace(x, 'TH', '0');
    x := regexp_replace(x, '[AEIOUY]', '', 'g');
    x := regexp_replace(x, '(.)\1+', '\1', 'g');
    x := left(x, 4);
    if x <> '' then out_parts := out_parts || x; end if;
  end loop;
  return array_to_string(out_parts, '');
end $$;

-- Name field similarity -> {score, reason}; mirror of nameFieldSimilarity()
create or replace function fn_name_similarity(a text, b text)
returns jsonb language plpgsql immutable as $$
declare
  x text := fn_norm_name(a);
  y text := fn_norm_name(b);
  tri numeric; tok numeric; s numeric;
begin
  if x = '' or y = '' then return jsonb_build_object('score', 0.5, 'reason', 'unknown'); end if;
  if x = y then return jsonb_build_object('score', 1, 'reason', 'exact'); end if;
  tri := fn_similarity(x, y);
  tok := fn_token_similarity(x, y);
  s := greatest(tri, tok);
  if s < 0.92 and fn_phonetic(x) <> '' and fn_phonetic(x) = fn_phonetic(y) then
    return jsonb_build_object('score', greatest(s, 0.88), 'reason', 'phonetic');
  end if;
  if s >= 0.9 then return jsonb_build_object('score', s, 'reason', 'near'); end if;
  if s >= 0.72 then return jsonb_build_object('score', s, 'reason', 'partial'); end if;
  if s >= 0.5 then return jsonb_build_object('score', s, 'reason', 'weak'); end if;
  return jsonb_build_object('score', s, 'reason', 'mismatch');
end $$;

-- ---------------------------------------------------------------------
-- Configuration helpers
-- ---------------------------------------------------------------------
create or replace function fn_setting(p_key text, p_default jsonb)
returns jsonb language sql stable as $$
  select coalesce((select value from settings where key = p_key), p_default)
$$;

create or replace function fn_duplicate_weights()
returns jsonb language sql stable as $$
  select fn_setting('duplicate_weights',
    '{"last_name":26,"first_name":22,"middle_name":8,"date_of_birth":20,"sex":5,"barangay":6,"address":8,"contact":5}'::jsonb)
$$;

create or replace function fn_duplicate_thresholds()
returns jsonb language sql stable as $$
  select fn_setting('duplicate_thresholds', '{"block":95,"warn":80,"notice":60}'::jsonb)
$$;

create or replace function fn_band_for(p_score numeric, p_thresholds jsonb default null)
returns match_band language plpgsql immutable as $$
declare
  t jsonb := coalesce(p_thresholds, '{"block":95,"warn":80,"notice":60}'::jsonb);
begin
  if p_score >= coalesce((t->>'block')::numeric, 95) then return 'VERY_LIKELY'; end if;
  if p_score >= coalesce((t->>'warn')::numeric, 80) then return 'POSSIBLE'; end if;
  if p_score >= coalesce((t->>'notice')::numeric, 60) then return 'POTENTIAL'; end if;
  return 'DISTINCT';
end $$;

-- ---------------------------------------------------------------------
-- Scoring: candidate (jsonb) vs one stored person row
-- ---------------------------------------------------------------------
create or replace function fn_score_pair(
  c jsonb,
  e persons,
  p_weights jsonb default null,
  p_thresholds jsonb default null)
returns jsonb language plpgsql stable as $$
begin
  return fn_score_json(
    c,
    fn_person_index_json(e) || jsonb_build_object('barangay_name', fn_person_barangay_name(e),
                                                  'identity_key', e.identity_key),
    p_weights, p_thresholds);
end $$;

-- ---------------------------------------------------------------------
-- Scoring core: candidate (jsonb) vs existing record (jsonb).
-- Used for live checks, import validation (file-vs-file and file-vs-registry)
-- and the comparison screen.
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

-- Helper: reason object with status + human readable detail
create or replace function fn_reason(
  p_field text, p_label text, p_sim numeric, p_weight numeric,
  p_a text, p_b text, p_meta jsonb, p_unknown boolean, p_conflict boolean)
returns jsonb language plpgsql immutable as $$
declare
  st text; detail text; sim_round numeric := round(coalesce(p_sim,0), 2);
begin
  if p_conflict then st := 'conflict';
  elsif p_unknown then st := 'unknown';
  elsif sim_round >= 0.95 then st := 'match';
  elsif sim_round >= 0.6 then st := 'partial';
  else st := 'mismatch';
  end if;

  detail := case
    when p_conflict and p_field = 'date_of_birth' then
      'Different dates: ' || coalesce(to_char(fn_norm_date(p_a), 'MM/DD/YYYY'), '—')
        || ' vs ' || coalesce(to_char(fn_norm_date(p_b), 'MM/DD/YYYY'), '—')
    when p_conflict then coalesce(p_a,'—') || ' vs ' || coalesce(p_b,'—')
    when p_unknown then
      case when p_field = 'date_of_birth' then 'Date of birth missing on one record'
           when p_field = 'middle_name' then 'Middle name not recorded on one record'
           when p_field = 'contact_number' then 'Contact number missing on one record'
           when p_field = 'barangay' then 'Barangay not indicated'
           else 'Not recorded on one record' end
    when st = 'match' then
      case when p_field in ('date_of_birth','sex','barangay','contact_number') then
             case when p_field = 'date_of_birth' then 'Both ' || to_char(fn_norm_date(p_a), 'MM/DD/YYYY')
                  when p_field = 'barangay' then 'Same barangay (' || coalesce(p_b,'—') || ')'
                  when p_field = 'contact_number' then 'Contact numbers match'
                  else 'Both ' || coalesce(p_a,'') end
           else 'Exact match after normalisation' end
    else
      case when p_field = 'address' then 'Address similarity ' || round(sim_round*100) || '%'
           else case coalesce(p_meta->>'reason','')
                  when 'phonetic' then 'Sounds the same (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  when 'near' then round(sim_round*100) || '% similar (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  when 'partial' then 'Partially similar — ' || round(sim_round*100) || '% (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  when 'weak' then 'Weak similarity — ' || round(sim_round*100) || '% (' || coalesce(p_a,'—') || ' ≈ ' || coalesce(p_b,'—') || ')'
                  else 'Different (' || coalesce(p_a,'—') || ' vs ' || coalesce(p_b,'—') || ')' end
           end
      end
  end;

  return jsonb_build_object(
    'field', p_field, 'label', p_label, 'status', st, 'similarity', sim_round,
    'weight', p_weight, 'detail', detail);
end $$;

-- Barangay name for a stored person row (used inside scoring)
create or replace function fn_person_barangay_name(p persons)
returns text language sql stable as $$
  select (select b.name from barangays b where b.id = p.barangay_id)
$$;
