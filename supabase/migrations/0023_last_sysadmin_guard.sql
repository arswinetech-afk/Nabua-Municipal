-- ---------------------------------------------------------------------
-- 0023: lockout guard (field incident 2026-09-21 22:41/22:48). An
-- Administrator cannot manage System Administrators, and the account
-- holding the only active System Administrator role was accidentally
-- demoted and set inactive — leaving nobody who could undo it. From
-- now on fn_upsert_user refuses to demote or deactivate the last
-- active System Administrator.
-- ---------------------------------------------------------------------

create or replace function fn_upsert_user(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor users := fn_current_actor(); u users; v_id uuid := nullif(p->>'id','')::uuid; t users;
begin
  perform fn_require_role('SYSTEM_ADMIN');
  if coalesce(btrim(p->>'name'),'') = '' or coalesce(btrim(p->>'email'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'Name and email are required.');
  end if;
  if coalesce(p->>'role','') not in ('ENCODER','ADMINISTRATOR','SYSTEM_ADMIN','VIEWER') then
    return jsonb_build_object('ok', false, 'error', 'Invalid role.');
  end if;

  -- 0023 field incident (2026-09-21 22:41): the creator account was
  -- demoted and deactivated by accident, leaving no active System
  -- Administrator and no in-app way back. The last active System
  -- Administrator can no longer be demoted or deactivated: promote
  -- another active account first.
  if v_id is not null then
    select * into t from users where id = v_id;
    if found and t.role = 'SYSTEM_ADMIN' and t.active then
      if not ((p->>'role') = 'SYSTEM_ADMIN' and coalesce((p->>'active')::boolean, true)) then
        if not exists (select 1 from users
                        where id <> v_id and role = 'SYSTEM_ADMIN' and active) then
          return jsonb_build_object('ok', false, 'error',
            'This is the last active System Administrator. Promote another active account to System Administrator first — the municipality must never lose its last one.');
        end if;
      end if;
    end if;
  end if;

  if v_id is null then
    insert into users (name, email, role, active, barangay_scope)
    values (btrim(p->>'name'), lower(btrim(p->>'email')), (p->>'role')::user_role,
            coalesce((p->>'active')::boolean, true), nullif(p->>'barangay_scope','')::uuid)
    returning * into u;
  else
    update users set name = btrim(p->>'name'), email = lower(btrim(p->>'email')),
           role = (p->>'role')::user_role,
           active = coalesce((p->>'active')::boolean, active),
           barangay_scope = nullif(p->>'barangay_scope','')::uuid,
           updated_at = now()
     where id = v_id returning * into u;
    if not found then return jsonb_build_object('ok', false, 'error', 'User not found.'); end if;
  end if;

  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
                          new_values, session_info)
  values (actor.id, actor.name, actor.role, case when v_id is null then 'USER_CREATED' else 'USER_UPDATED' end,
          'USERS', u.id, u.name || ' (' || u.email || ')',
          jsonb_build_object('role', u.role, 'active', u.active), fn_session_info());

  return jsonb_build_object('ok', true, 'user', jsonb_build_object(
    'id', u.id, 'name', u.name, 'email', u.email, 'role', u.role, 'active', u.active,
    'barangay_scope', u.barangay_scope, 'created_at', u.created_at, 'last_login', u.last_login));
end $$;
