-- =====================================================================
-- NMBR — 0003_guard_triggers.sql
-- Database-level duplicate protection, column maintenance and audit.
--
-- The unique index persons_identity_key_uidx is the final safety net, but
-- because a municipality can genuinely contain two people with the same name
-- and birthdate, the guard trigger runs first and is allowed to append a
-- discriminator (#2, #3, ...) when an AUTHORISED user explicitly declared the
-- record to be a different person. In that case the pair is also queued into
-- duplicate_cases so that a supervisor can still review it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Actor resolution (works with Supabase JWT *and* with the local backend,
-- which sets the nmbr.actor GUC for the transaction)
-- ---------------------------------------------------------------------
create or replace function fn_auth_uid()
returns uuid language plpgsql stable as $$
declare v_uid uuid;
begin
  if to_regprocedure('auth.uid()') is not null then
    begin
      execute 'select auth.uid()' into v_uid;
      return v_uid;
    exception when others then
      return null;
    end;
  end if;
  return null;
end $$;

create or replace function fn_current_actor()
returns users language plpgsql stable as $$
declare
  u users;
  guc text := nullif(current_setting('nmbr.actor', true), '');
  uid uuid := fn_auth_uid();
begin
  if guc is not null then
    select * into u from users where id = guc::uuid;
    if found then return u; end if;
  end if;
  if uid is not null then
    select * into u from users where auth_user_id = uid limit 1;
    if found then return u; end if;
  end if;
  return null;
end $$;

create or replace function fn_current_user_id()
returns uuid language sql stable as $$ select (fn_current_actor()).id $$;

create or replace function fn_current_role()
returns user_role language sql stable as $$
  select coalesce((fn_current_actor()).role, 'VIEWER'::user_role)
$$;

create or replace function fn_is_role(variadic p_roles text[])
returns boolean language sql stable as $$
  select coalesce((fn_current_actor()).role::text = any(p_roles), false)
     and coalesce((fn_current_actor()).active, false)
$$;

/** Raises a structured, client-friendly error when the actor lacks the role. */
create or replace function fn_require_role(variadic p_roles text[])
returns void language plpgsql stable as $$
declare r text := fn_current_role()::text; act users := fn_current_actor();
begin
  if act.id is null or not act.active then
    raise exception 'NMBR_UNAUTHENTICATED: Your session is not recognised. Please sign in again.'
      using errcode = 'P0002';
  end if;
  if not (r = any(p_roles)) then
    raise exception 'NMBR_FORBIDDEN: Your role (%) is not permitted to perform this action. Required: %.',
      r, array_to_string(p_roles, ' or ') using errcode = 'P0003';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Duplicate override flag (transaction scoped)
-- fn_create_person(name..., p_confirmed_distinct => true) sets this so that the
-- guard allows a *legitimate* namesake and records the reason in the audit log.
-- ---------------------------------------------------------------------
create or replace function fn_duplicate_override_active()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('nmbr.allow_identity_duplicate', true), ''), 'off') = 'on'
$$;

create or replace function fn_set_duplicate_override(p_on boolean)
returns void language plpgsql as $$
begin
  perform set_config('nmbr.allow_identity_duplicate', case when p_on then 'on' else 'off' end, true);
end $$;

-- ---------------------------------------------------------------------
-- Guard: identity keys, normalised columns and hard duplicate prevention
-- ---------------------------------------------------------------------
create or replace function fn_persons_before_write()
returns trigger language plpgsql as $$
declare
  v_key text;
  v_existing persons;
  v_suffix int;
  v_actor users := fn_current_actor();
begin
  new.first_name  := nullif(btrim(coalesce(new.first_name,'')), '');
  new.middle_name := nullif(btrim(coalesce(new.middle_name,'')), '');
  new.last_name   := nullif(btrim(coalesce(new.last_name,'')), '');
  new.suffix      := nullif(btrim(coalesce(new.suffix,'')), '');

  if new.first_name is null or new.last_name is null then
    raise exception 'NMBR_VALIDATION: First name and last name are required.' using errcode = 'P0004';
  end if;

  -- normalised search columns
  new.name_search    := fn_norm_text(concat_ws(' ', new.first_name, new.middle_name, new.last_name, new.suffix));
  new.last_search    := fn_norm_name(new.last_name);
  new.first_search   := fn_norm_name(new.first_name);
  new.contact_search := fn_norm_contact(new.contact_number);
  new.phonetic_key   := fn_phonetic(new.last_name) || '|' || fn_phonetic(new.first_name);
  new.updated_at     := now();

  if new.status = 'ARCHIVED' and new.archived_at is null then
    new.archived_at := now();
  end if;
  if new.status <> 'ARCHIVED' then
    new.archived_at := null;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, v_actor.id);
  end if;
  new.updated_by := coalesce(v_actor.id, new.updated_by);

  -- identity key maintenance
  if new.identity_lock then
    v_key := fn_identity_key(new.first_name, new.middle_name, new.last_name, new.suffix, new.date_of_birth);

    -- keep an existing discriminator when the key body has not changed
    if tg_op = 'UPDATE'
       and old.identity_key is not null
       and split_part(old.identity_key, '#', 1) = v_key
       and position('#' in old.identity_key) > 0 then
      new.identity_key := old.identity_key;
    else
      new.identity_key := v_key;
    end if;

    if new.status <> 'ARCHIVED' and new.merged_into is null and v_key <> '' then
      select * into v_existing from persons
        where identity_key = v_key
          and id <> new.id
          and status <> 'ARCHIVED'
          and merged_into is null
        limit 1;

      if found then
        if fn_duplicate_override_active() then
          -- authorised namesake: keep uniqueness with a discriminator
          select count(*) into v_suffix from persons
            where split_part(identity_key, '#', 1) = v_key;
          new.identity_key := v_key || '#' || greatest(v_suffix, 1);
          if new.status = 'ACTIVE' then
            new.status := 'FOR_REVIEW';
          end if;
          -- queue the namesake pair for a supervisor; the actual INSERT into
          -- duplicate_cases happens AFTER this row exists (FK requirement)
          perform set_config('nmbr.pending_namesake', v_existing.id::text, true);
        else
          raise exception using
            errcode = 'P0005',
            message = 'NMBR_DUPLICATE: An existing master record already matches this identity.',
            detail = jsonb_build_object(
              'code', 'IDENTITY_CONFLICT',
              'existing_person_id', v_existing.id,
              'existing_reference_no', v_existing.reference_no,
              'existing_name', concat_ws(' ', v_existing.first_name, v_existing.middle_name, v_existing.last_name),
              'existing_barangay_id', v_existing.barangay_id,
              'identity_key', v_key
            )::text,
            hint = 'Use the existing record, or declare this as a different person and let a supervisor review it.';
        end if;
      end if;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_persons_before_write on persons;
create trigger trg_persons_before_write
  before insert or update on persons
  for each row execute function fn_persons_before_write();


-- ---------------------------------------------------------------------
-- After-insert bookkeeping: an accepted "different person with an identical
-- identity key" is queued for supervisor review (never silently allowed).
-- ---------------------------------------------------------------------
create or replace function fn_persons_after_insert()
returns trigger language plpgsql as $$
declare
  v_pending text := nullif(current_setting('nmbr.pending_namesake', true), '');
  v_actor users := fn_current_actor();
  v_existing persons;
begin
  if v_pending is not null then
    select * into v_existing from persons where id = v_pending::uuid;
    if v_existing.id is not null then
      insert into duplicate_cases (person_id_a, person_id_b, match_score, match_band,
                                   matching_fields, matched_details, status, source,
                                   notes, created_by)
      values (v_existing.id, new.id, 100, 'VERY_LIKELY',
              array['last_name','first_name','middle_name','date_of_birth'],
              jsonb_build_object(
                'reason', 'Identity key collision accepted as a different person by ' ||
                          coalesce(v_actor.name, 'system'),
                'identity_key', new.identity_key),
              'PENDING', 'LIVE_CHECK',
              'Automatically queued: identical identity key accepted with an explicit override. Verify that these are genuinely two different residents.',
              v_actor.id)
      on conflict do nothing;
    end if;
    perform set_config('nmbr.pending_namesake', '', true);
  end if;
  return new;
end $$;

drop trigger if exists trg_persons_after_insert on persons;
create trigger trg_persons_after_insert
  after insert on persons
  for each row execute function fn_persons_after_insert();

-- ---------------------------------------------------------------------
-- Generic audit trail on the master registry (append only)
-- ---------------------------------------------------------------------
create or replace function fn_persons_audit()
returns trigger language plpgsql as $$
declare
  actor users := fn_current_actor();
  changed text[] := '{}';
  old_j jsonb;
  new_j jsonb;
  label text;
begin
  if coalesce(current_setting('nmbr.audit_silent', true), 'off') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id,
                            entity_label, old_values, new_values, changed_fields, session_info)
    values (actor.id, actor.name, actor.role, 'CREATED', 'PERSONS', new.id,
            concat_ws(' ', new.first_name, new.last_name), null, to_jsonb(new),
            array['record'], fn_session_info());
    return new;
  end if;

  old_j := to_jsonb(old);
  new_j := to_jsonb(new);
  select array_agg(k) into changed from (
    select key as k from jsonb_each(new_j) n
    where key not in ('updated_at','updated_by','name_search','last_search','first_search',
                      'contact_search','phonetic_key','identity_key','id','created_at','created_by')
      and n.value is distinct from old_j->key
  ) s;
  changed := coalesce(changed, '{}');

  if array_length(changed, 1) is null then
    return new;
  end if;

  label := concat_ws(' ', new.first_name, new.last_name);
  insert into audit_logs (user_id, user_name, user_role, action, entity_type, entity_id,
                          entity_label, old_values, new_values, changed_fields, reason, session_info)
  values (actor.id, actor.name, actor.role, 'UPDATED', 'PERSONS', new.id, label,
          (select jsonb_object_agg(k, old_j->k) from unnest(changed) k),
          (select jsonb_object_agg(k, new_j->k) from unnest(changed) k),
          changed,
          nullif(current_setting('nmbr.audit_reason', true), ''),
          fn_session_info());
  return new;
end $$;

drop trigger if exists trg_persons_audit on persons;
create trigger trg_persons_audit
  after insert or update on persons
  for each row execute function fn_persons_audit();

create or replace function fn_session_info()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'user_agent', nullif(current_setting('nmbr.user_agent', true), ''),
    'device', nullif(current_setting('nmbr.device', true), ''),
    'session_id', nullif(current_setting('nmbr.session_id', true), ''),
    'app', 'NMBR',
    'at', now())
$$;

-- ---------------------------------------------------------------------
-- Immutable audit log — nothing may rewrite history
-- ---------------------------------------------------------------------
create or replace function fn_audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'NMBR_AUDIT_IMMUTABLE: Audit log entries cannot be modified or deleted.'
    using errcode = 'P0006';
end $$;

drop trigger if exists trg_audit_immutable on audit_logs;
create trigger trg_audit_immutable
  before update or delete on audit_logs
  for each row execute function fn_audit_immutable();

-- ---------------------------------------------------------------------
-- Barangay history keeps the person's current barangay in sync.
-- One open (effective_to is null) row per person is the source of truth.
-- ---------------------------------------------------------------------
create or replace function fn_barangay_history_sync()
returns trigger language plpgsql as $$
declare
  rec member_barangay_history;
begin
  rec := coalesce(new, old);

  if tg_op = 'DELETE' then
    update persons set barangay_id = (
      select barangay_id from member_barangay_history
       where person_id = rec.person_id and effective_to is null
       order by effective_from desc limit 1)
     where id = rec.person_id;
    return rec;
  end if;

  if new.effective_to is null then
    -- close any other open row for this person
    update member_barangay_history
       set effective_to = coalesce(new.effective_from, current_date) - 1,
           status = 'ENDED'
     where person_id = new.person_id
       and id <> new.id
       and effective_to is null;

    update persons set barangay_id = new.barangay_id
     where id = new.person_id and barangay_id is distinct from new.barangay_id;
  end if;

  return new;
end $$;

drop trigger if exists trg_barangay_history_sync on member_barangay_history;
create trigger trg_barangay_history_sync
  after insert or update or delete on member_barangay_history
  for each row execute function fn_barangay_history_sync();

-- ---------------------------------------------------------------------
-- Import row / duplicate case bookkeeping
-- ---------------------------------------------------------------------
create or replace function fn_duplicate_cases_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status <> 'PENDING' and new.reviewed_at is null then
    new.reviewed_at := now();
    new.reviewed_by := coalesce(new.reviewed_by, fn_current_user_id());
  end if;
  return new;
end $$;

drop trigger if exists trg_duplicate_cases_touch on duplicate_cases;
create trigger trg_duplicate_cases_touch
  before update on duplicate_cases
  for each row execute function fn_duplicate_cases_touch();
