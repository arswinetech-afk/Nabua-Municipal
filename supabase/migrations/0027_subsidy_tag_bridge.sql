-- ---------------------------------------------------------------------
-- 0027: tag → beneficiary bridge (field directive 2026-09-22).
-- Rice-subsidy-class sheets now land in the registry carrying their
-- tick columns as member tags (0013 tags, importer 2026-09-22):
-- 4PS, WALANG GUTOM, SOCIAL PENSION PROGRAM, SENIOR CITIZEN, PWD,
-- SOLO PARENT, FARMER, FISHERFOLK, PUBLIC TRANSPORT DRIVER, …
-- This bridge lets an encoder add every member carrying a chosen tag
-- to a subsidy programme in one explicit, previewed action instead of
-- searching and adding hundreds of rows one by one.
--
-- GO_LIVE §10 is preserved: eligibility stays a human decision. The
-- bridge never runs by itself — an operator picks the programme, picks
-- the tag, previews the match, then confirms. Bridged rows are added
-- as *pending* (verified = false) so every one is still cross-checked
-- against the barangay paper list before it counts as verified, and
-- the whole action is written to the audit log.
-- ---------------------------------------------------------------------

-- Which registry tags exist right now, and how many members carry each.
create or replace function fn_subsidy_tag_counts()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rows jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER');
  select coalesce(jsonb_agg(jsonb_build_object('tag', t.tag, 'members', t.n)
                            order by t.n desc, t.tag), '[]'::jsonb) into rows
  from (
    select upper(btrim(x)) as tag, count(*) as n
    from persons p
    cross join lateral unnest(coalesce(p.tags, '{}')) as x
    where p.merged_into is null
      and p.status <> 'ARCHIVED'
      and btrim(x) <> ''
    group by 1
  ) t;
  return jsonb_build_object('rows', rows);
end $$;

-- Add every active member carrying p->>'tag' to p->>'program_id'.
-- dry_run = true only reports what would happen (matched / already
-- listed / would_add plus a five-name sample); the real run inserts
-- the missing rows, skips anyone already on the programme list, and
-- audits the batch as a single action.
create or replace function fn_subsidy_bridge_tag(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor users := fn_current_actor();
  v_prog_id uuid := nullif(p->>'program_id','')::uuid;
  v_program subsidy_programs;
  v_tag text := upper(btrim(coalesce(p->>'tag','')));
  v_dry boolean := coalesce((p->>'dry_run')::boolean, false);
  v_code text := nullif(p->>'classification_code','');
  v_paper text := nullif(p->>'paper_ref','');
  v_notes text := coalesce(nullif(p->>'notes',''),
                           'Bridged from registry tag "' || v_tag || '"');
  matched int := 0;
  already int := 0;
  added int := 0;
  sample jsonb;
begin
  perform fn_require_role('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN');

  select * into v_program from subsidy_programs where id = v_prog_id;
  if v_program.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND',
      'error', 'That programme is not on the server. Re-sync and try again.');
  end if;
  if v_tag = '' then
    return jsonb_build_object('ok', false, 'code', 'BAD_INPUT',
      'error', 'Choose which registry tag to bridge.');
  end if;

  create temp table bridge_match on commit drop as
  select per.id, per.barangay_id, per.classification_code,
         concat_ws(' ', per.first_name, per.middle_name, per.last_name) as name
  from persons per
  where per.merged_into is null
    and per.status <> 'ARCHIVED'
    and exists (select 1 from unnest(coalesce(per.tags, '{}')) as x
                where upper(btrim(x)) = v_tag);

  select count(*) into matched from bridge_match;
  select count(*) into already from bridge_match m
  where exists (select 1 from subsidy_beneficiaries b
                where b.program_id = v_prog_id and b.person_id = m.id);
  select coalesce(jsonb_agg(x.name order by x.name), '[]'::jsonb) into sample
  from (
    select m.name from bridge_match m
    where not exists (select 1 from subsidy_beneficiaries b
                      where b.program_id = v_prog_id and b.person_id = m.id)
    order by m.name limit 5
  ) x;

  if v_dry then
    return jsonb_build_object('ok', true, 'dry_run', true,
      'matched', matched, 'already_listed', already,
      'would_add', matched - already, 'sample', sample);
  end if;

  insert into subsidy_beneficiaries (program_id, person_id, barangay_id,
                                     classification_code, verified, paper_ref,
                                     notes, added_by)
  select v_prog_id, m.id, m.barangay_id,
         coalesce(v_code, m.classification_code), false, v_paper, v_notes, actor.id
  from bridge_match m
  on conflict on constraint subsidy_once_per_program do nothing;
  get diagnostics added = row_count;

  update subsidy_programs set updated_at = now() where id = v_prog_id;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type,
                          entity_id, entity_label, new_values, changed_fields,
                          reason, session_info)
  values (actor.id, actor.name, actor.role, 'CREATED', 'SUBSIDY_BENEFICIARIES',
          v_prog_id, v_program.name || ' — tag bridge "' || v_tag || '"',
          jsonb_build_object('tag', v_tag, 'matched', matched, 'added', added,
                             'already_listed', already),
          array['tag_bridge'], v_notes, fn_session_info());

  return jsonb_build_object('ok', true, 'matched', matched, 'added', added,
                            'skipped', matched - added, 'sample', sample);
end $$;
