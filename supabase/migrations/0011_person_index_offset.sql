-- ---------------------------------------------------------------------
-- 0011: paged offline mirror. fn_person_index gains p_offset so a
-- municipality-scale registry (40 000+ members) can be mirrored page by
-- page instead of one ~16 MB response. CREATE OR REPLACE cannot change an
-- argument list: drop the old two-argument twin by exact signature.
-- ---------------------------------------------------------------------
drop function if exists fn_person_index(uuid, int);

create or replace function fn_person_index(p_barangay_id uuid default null, p_limit int default 20000, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows_json jsonb;
  off int := greatest(coalesce(p_offset, 0), 0);
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select coalesce(jsonb_agg(fn_person_index_json(p)), '[]'::jsonb) into rows_json
  from (
    select * from persons p
     where p.status <> 'ARCHIVED' and p.merged_into is null
       and (p_barangay_id is null or p.barangay_id = p_barangay_id)
     order by p.updated_at desc
     limit least(greatest(coalesce(p_limit, 20000), 1), 50000)
     offset off
  ) p;
  return jsonb_build_object('rows', rows_json, 'generated_at', now());
end $$;
