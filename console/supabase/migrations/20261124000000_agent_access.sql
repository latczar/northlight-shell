-- Who may use, approve and manage which AI employee, per client. Northlight admins change it on the People page; the app's
-- server writes it with the service role, only through set_agent_access(). Nothing in the browser writes here.
--
-- Nobody gets an employee automatically, Northlight admins included: a person may use exactly the employees with an active row,
-- approve where can_approve is set and manage where can_manage is set. Revokes are soft (revoked_at), never deletes.
-- After every change the app sends the client's full approver and manager lists to the agent (PUT /v1/access/approvers),
-- versioned by brain_sync so a late push never brings back a revoked right.

create table public.agent_access (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null,
  agent_id text not null,
  can_approve boolean not null default false,
  can_manage boolean not null default false,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  -- the brain_sync version this row last changed in; the brain has it once pushed_version reaches it
  changed_version bigint not null default 0,
  primary key (user_id, client_id, agent_id),
  constraint agent_access_shape check (client_id ~ '^[a-z0-9-]{1,64}$' and agent_id ~ '^[a-z0-9-]{1,32}$')
);
create index agent_access_client_idx on public.agent_access (client_id) where revoked_at is null;
create index agent_access_updated_by_idx on public.agent_access (updated_by);

-- Per client: the version of approver state the brain should hold and the one it has accepted.
-- wanted_version comes from brain_sync_version and is bumped in the same transaction as the rows.
create sequence public.brain_sync_version;
create table public.brain_sync (
  client_id text primary key check (client_id ~ '^[a-z0-9-]{1,64}$'),
  wanted_version bigint not null,
  pushed_version bigint not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);

alter table public.agent_access enable row level security;
alter table public.brain_sync enable row level security;

-- A signed-in person reads only their own rows (revoked ones included; they grant nothing).
create policy agent_access_select_own on public.agent_access
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.agent_access, public.brain_sync from anon, authenticated;
revoke all on sequence public.brain_sync_version from anon, authenticated;
grant select on public.agent_access to authenticated;

-- The account for an email, if any (the Auth admin API cannot look one up by email).
create function public.access_user_id_for_email(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;

-- One person's complete access to one client. p_rows: [{agent_id, can_approve, can_manage}], every employee they keep;
-- employees left out are revoked. When anything changed, the client's wanted version is bumped in the same transaction
-- and the changed rows carry it (changed_version).
-- p_expected: when the People page read this person's access (the newest updated_at of their rows for the client,
-- revoked ones included); if a row changed since, nothing is written (40001), so a stale page cannot undo another admin's
-- change. p_add: the person is being added, so nothing is written (23505) when they already have access here; both
-- checks run under the client's lock, so two admins at once cannot overwrite each other. Returns {changed, wanted_version}.
create function public.set_agent_access(p_actor uuid, p_user_id uuid, p_client_id text, p_rows jsonb, p_expected timestamptz default null, p_add boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_changed bigint := 0;
  v_count bigint;
  v_version bigint;
  v_next bigint;
begin
  if p_client_id is null or p_client_id !~ '^[a-z0-9-]{1,64}$' then
    raise exception 'client id must be lowercase letters, digits and -' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_rows)) <> (select count(distinct e->>'agent_id') from jsonb_array_elements(p_rows) e) then
    raise exception 'each employee may appear once' using errcode = '22023';
  end if;
  -- every write says what it saw: the page's p_expected, or p_add for someone new
  if p_expected is null and not coalesce(p_add, false) then
    raise exception 'pass p_expected (what the page read) or p_add (a new person)' using errcode = '22023';
  end if;

  -- One writer per client at a time, so versions follow the order the rows changed in.
  perform pg_advisory_xact_lock(hashtextextended('agent_access:' || p_client_id, 0));

  if p_add and exists (select 1 from public.agent_access a where a.user_id = p_user_id and a.client_id = p_client_id and a.revoked_at is null) then
    raise exception 'this person already has access here' using errcode = '23505';
  end if;
  if p_expected is not null and p_expected is distinct from
    (select max(a.updated_at) from public.agent_access a where a.user_id = p_user_id and a.client_id = p_client_id) then
    raise exception 'this person''s access changed since it was read' using errcode = '40001';
  end if;

  -- taken under the lock, so versions follow the order the changes happened in (unused when nothing changes)
  v_next := nextval('public.brain_sync_version');

  update public.agent_access a set revoked_at = now(), updated_at = now(), updated_by = p_actor, changed_version = v_next
    where a.user_id = p_user_id and a.client_id = p_client_id and a.revoked_at is null
      and not exists (select 1 from jsonb_to_recordset(p_rows) as d (agent_id text) where d.agent_id = a.agent_id);
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  insert into public.agent_access (user_id, client_id, agent_id, can_approve, can_manage, updated_by, changed_version)
    select p_user_id, p_client_id, d.agent_id, coalesce(d.can_approve, false), coalesce(d.can_manage, false), p_actor, v_next
    from jsonb_to_recordset(p_rows) as d (agent_id text, can_approve boolean, can_manage boolean)
    on conflict (user_id, client_id, agent_id) do update
      set can_approve = excluded.can_approve, can_manage = excluded.can_manage, revoked_at = null,
          updated_at = now(), updated_by = excluded.updated_by, changed_version = excluded.changed_version
      where public.agent_access.revoked_at is not null
         or public.agent_access.can_approve <> excluded.can_approve
         or public.agent_access.can_manage <> excluded.can_manage;
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  if v_changed > 0 then
    insert into public.brain_sync (client_id, wanted_version) values (p_client_id, v_next)
      on conflict (client_id) do update set wanted_version = v_next, updated_at = now();
  end if;
  select wanted_version into v_version from public.brain_sync where client_id = p_client_id;
  return jsonb_build_object('changed', v_changed > 0, 'wanted_version', v_version);
end $$;

-- Whether the brain may still hold an older copy of this person's rights anywhere in this business: one of their rows
-- changed in a version the brain has not accepted yet. Business-wide, because the brain lets an approver of any employee
-- decide a lesson for the whole team. The app sends the lists again before it starts a new job for the person, or decides
-- a request they asked for (a decision resumes their job), and stops while this stays true. A job already running, or a
-- message already waiting behind it, still runs on the brain's copy.
create function public.access_pending(p_user_id uuid, p_client_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.agent_access a join public.brain_sync s on s.client_id = a.client_id
    where a.user_id = p_user_id and a.client_id = p_client_id and a.changed_version > s.pushed_version)
$$;

-- One statement, so the version and the rows come from the same snapshot: the client's sync row and every active
-- approver and manager. Null when nothing was ever saved for the client.
create function public.access_push_state(p_client_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'wanted_version', s.wanted_version,
    'pushed_version', s.pushed_version,
    'last_error', s.last_error,
    'updated_at', s.updated_at,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'agent_id', a.agent_id, 'can_approve', a.can_approve, 'can_manage', a.can_manage) order by a.agent_id, a.user_id)
      from public.agent_access a
      where a.revoked_at is null and a.client_id = p_client_id and (a.can_approve or a.can_manage)
    ), '[]'::jsonb))
  from public.brain_sync s where s.client_id = p_client_id
$$;

-- The brain accepted p_version. Never goes backwards.
create function public.access_push_done(p_client_id text, p_version bigint) returns void
language sql security definer set search_path = '' as $$
  update public.brain_sync set pushed_version = greatest(pushed_version, p_version), last_error = null, updated_at = now()
  where client_id = p_client_id
$$;

-- Kept only while the brain is behind: an older push failing after a newer one went through says nothing about now.
create function public.access_push_failed(p_client_id text, p_error text) returns void
language sql security definer set search_path = '' as $$
  update public.brain_sync set last_error = left(p_error, 300), updated_at = now()
  where client_id = p_client_id and pushed_version < wanted_version
$$;

-- The People page: everyone with an active row for this client, with their sign-in email, the name an admin gave them
-- (app metadata, which only the server writes; a person cannot rename themselves here) and changed_at, the newest change
-- to any of their rows for this client (set_agent_access's p_expected).
create function public.access_people(p_client_id text)
returns table (user_id uuid, email text, full_name text, agent_id text, can_approve boolean, can_manage boolean, changed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.user_id, u.email::text, nullif(u.raw_app_meta_data->>'full_name', ''),
         a.agent_id, a.can_approve, a.can_manage,
         (select max(b.updated_at) from public.agent_access b where b.user_id = a.user_id and b.client_id = a.client_id)
  from public.agent_access a join auth.users u on u.id = a.user_id
  where a.client_id = p_client_id and a.revoked_at is null
  order by lower(u.email::text), a.agent_id
$$;

revoke all on function
  public.access_user_id_for_email(text), public.set_agent_access(uuid, uuid, text, jsonb, timestamptz, boolean),
  public.access_pending(uuid, text),
  public.access_push_state(text), public.access_push_done(text, bigint), public.access_push_failed(text, text),
  public.access_people(text)
  from public, anon, authenticated;
grant execute on function
  public.access_user_id_for_email(text), public.set_agent_access(uuid, uuid, text, jsonb, timestamptz, boolean),
  public.access_pending(uuid, text),
  public.access_push_state(text), public.access_push_done(text, bigint), public.access_push_failed(text, text),
  public.access_people(text)
  to service_role;
