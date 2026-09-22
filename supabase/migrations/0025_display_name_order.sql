-- ---------------------------------------------------------------------
-- 0025: field report 2026-09-22 09:00 — "Sort Member A-Z" ordered by
-- surname while the cards display given name first, so the list read
-- unsorted to staff. Name order now follows the displayed name:
-- first, middle, last.
-- ---------------------------------------------------------------------

create or replace function fn_search_persons(
  p_query text default '',
  p_barangay_id uuid default null,
  p_status text default null,
  p_sex text default null,
  p_purok text default null,
  p_duplicates_only boolean default false,
  p_for_review_only boolean default false,
  p_attention_only boolean default false,
  p_created_since date default null,
  p_sort text default 'name',
  p_dir text default 'asc',
  p_limit int default 25,
  p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q text := btrim(coalesce(p_query, ''));
  qn text := fn_norm_text(q);
  qd text := fn_norm_digits(q);
  qdate date := fn_norm_date(q);
  rows_json jsonb;
  total bigint;
  lim int := least(greatest(coalesce(p_limit, 25), 1), 200);
  off int := greatest(coalesce(p_offset, 0), 0);
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');

  with filtered as (
    select p.*
    from persons p
    where (p_barangay_id is null or p.barangay_id = p_barangay_id)
      and (p_status is null or p.status::text = p_status)
      and (p_sex is null or p.sex = p_sex)
      and (p_purok is null or fn_norm_text(p.purok) = fn_norm_text(p_purok))
      and (p.status <> 'ARCHIVED' or p_status = 'ARCHIVED')
      and (p_created_since is null or p.created_at::date >= p_created_since)
      and (not p_duplicates_only or exists (
            select 1 from duplicate_cases d
             where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (not p_for_review_only or p.status = 'FOR_REVIEW')
      and (not p_attention_only or p.date_of_birth is null or p.sex is null or p.barangay_id is null
           or p.address is null or p.purok is null
           or (p.contact_search <> '' and length(p.contact_search) < 7)
           or exists (select 1 from duplicate_cases d
                       where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (
        q = '' or
        (qn <> '' and p.name_search like '%' || qn || '%') or
        (qn <> '' and fn_similarity(p.name_search, qn) >= 0.45) or
        (qd <> '' and length(qd) >= 6 and p.contact_search = fn_norm_contact(qd)) or
        (qd <> '' and p.reference_no ilike '%' || qd || '%') or
        (qdate is not null and p.date_of_birth = qdate) or
        (qn <> '' and fn_norm_text(fn_person_barangay_name(p)) like '%' || qn || '%') or
        (qn <> '' and fn_norm_text(p.purok) like '%' || qn || '%')
      )
  )
  select count(*) into total from filtered;

  with filtered as (
    select p.* from persons p
    where (p_barangay_id is null or p.barangay_id = p_barangay_id)
      and (p_status is null or p.status::text = p_status)
      and (p_sex is null or p.sex = p_sex)
      and (p_purok is null or fn_norm_text(p.purok) = fn_norm_text(p_purok))
      and (p.status <> 'ARCHIVED' or p_status = 'ARCHIVED')
      and (p_created_since is null or p.created_at::date >= p_created_since)
      and (not p_duplicates_only or exists (
            select 1 from duplicate_cases d
             where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (not p_for_review_only or p.status = 'FOR_REVIEW')
      and (not p_attention_only or p.date_of_birth is null or p.sex is null or p.barangay_id is null
           or p.address is null or p.purok is null
           or (p.contact_search <> '' and length(p.contact_search) < 7)
           or exists (select 1 from duplicate_cases d
                       where d.status = 'PENDING' and (d.person_id_a = p.id or d.person_id_b = p.id)))
      and (
        q = '' or
        (qn <> '' and p.name_search like '%' || qn || '%') or
        (qn <> '' and fn_similarity(p.name_search, qn) >= 0.45) or
        (qd <> '' and length(qd) >= 6 and p.contact_search = fn_norm_contact(qd)) or
        (qd <> '' and p.reference_no ilike '%' || qd || '%') or
        (qdate is not null and p.date_of_birth = qdate) or
        (qn <> '' and fn_norm_text(fn_person_barangay_name(p)) like '%' || qn || '%') or
        (qn <> '' and fn_norm_text(p.purok) like '%' || qn || '%')
      )
    order by
      -- 0025: "Member A-Z" must read the way the card displays the name —
      -- given name first. Surname-first ordering looked unsorted to staff.
      case when p_sort = 'name' and p_dir = 'asc' then p.first_name end asc nulls last,
      case when p_sort = 'name' and p_dir = 'asc' then p.middle_name end asc nulls last,
      case when p_sort = 'name' and p_dir = 'asc' then p.last_name end asc nulls last,
      case when p_sort = 'name' and p_dir = 'desc' then p.first_name end desc nulls last,
      case when p_sort = 'name' and p_dir = 'desc' then p.middle_name end desc nulls last,
      case when p_sort = 'name' and p_dir = 'desc' then p.last_name end desc nulls last,
      case when p_dir = 'asc' then
        case p_sort when 'updated' then null when 'barangay' then null when 'name' then null else p.last_search end
      end asc nulls last,
      case when p_sort = 'updated' and p_dir = 'asc' then p.updated_at end asc,
      case when p_sort = 'updated' and p_dir = 'desc' then p.updated_at end desc,
      case when p_sort = 'barangay' and p_dir = 'asc' then fn_person_barangay_name(p) end asc,
      case when p_sort = 'barangay' and p_dir = 'desc' then fn_person_barangay_name(p) end desc,
      case when p_sort = 'dob' and p_dir = 'asc' then p.date_of_birth end asc nulls last,
      case when p_sort = 'dob' and p_dir = 'desc' then p.date_of_birth end desc nulls last,
      p.first_search asc, p.created_at desc
    limit lim offset off
  )
  select coalesce(jsonb_agg(fn_person_json(f)), '[]'::jsonb) into rows_json from filtered f;

  return jsonb_build_object('total', coalesce(total,0), 'rows', rows_json, 'limit', lim, 'offset', off);
end $$;
