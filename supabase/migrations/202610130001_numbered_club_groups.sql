begin;

-- Provide the first three numbered groups as empty workspaces. The stable
-- codes make setup idempotent, and no member identities or assignments are
-- guessed here. Owners can add further groups through save_club_team().
insert into public.club_teams(team_code,team_name,description)
values
  ('GROUP-1','Group #1',''),
  ('GROUP-2','Group #2',''),
  ('GROUP-3','Group #3','')
on conflict (team_code) do nothing;

-- Portfolio coverage must remain inside the Intern's assigned group. The
-- group manager list is the authority for which Managers can review and
-- execute that group's paper proposals.
create or replace function public.set_portfolio_coverage(
  target_user_id uuid,
  team_code text,
  manager_user_ids uuid[]
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target_role text;
  manager_ids uuid[] := coalesce(manager_user_ids,'{}'::uuid[]);
  normalized_code text := upper(btrim(coalesce(team_code,'')));
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);

  if target_user_id is null then raise exception 'Choose an active Intern or Quant member'; end if;
  if not exists(select 1 from public.club_teams t where t.team_code=normalized_code and t.active=true) then
    raise exception 'Choose an active group';
  end if;
  select m.role into target_role
  from public.members m
  where m.id=target_user_id and m.active=true
  for update;
  if target_role not in ('intern','quant') or target_role is null then
    raise exception 'Assign a group to an active Intern or Quant member';
  end if;
  if cardinality(manager_ids)>20 then raise exception 'Choose at most 20 portfolio managers'; end if;
  if target_role='quant' and cardinality(manager_ids)>0 then
    raise exception 'Quant members are assigned to groups, not intern portfolios';
  end if;
  if exists(
    select 1 from unnest(manager_ids) selected(manager_id)
    where selected.manager_id is null or not exists(
      select 1
      from public.members m
      join public.club_team_managers tm on tm.manager_id=m.id
      where m.id=selected.manager_id
        and m.role='manager' and m.active=true
        and tm.team_code=normalized_code
    )
  ) then
    raise exception 'Every portfolio Manager must be an active Manager assigned to this group';
  end if;

  insert into public.club_team_members(user_id,team_code,assigned_by,updated_at)
    values(target_user_id,normalized_code,auth.uid(),now())
    on conflict(user_id) do update
      set team_code=excluded.team_code,assigned_by=excluded.assigned_by,updated_at=now();
  delete from public.portfolio_assignments where portfolio_owner_id=target_user_id;
  insert into public.portfolio_assignments(portfolio_owner_id,manager_id,assigned_by)
    select target_user_id,selected.manager_id,auth.uid()
    from (select distinct manager_id from unnest(manager_ids) selected(manager_id)) selected;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'portfolio.coverage_changed',target_user_id,
      jsonb_build_object('team_code',normalized_code,'manager_ids',to_jsonb(manager_ids)));
end;
$$;

-- A member or assigned Manager may view names and roles in their own active
-- group. Emails and administrative fields remain restricted to the Owner's
-- list_admin_members() RPC.
create or replace function public.list_my_team_members()
returns table(team_code text,team_name text,user_id uuid,full_name text,role text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.members m where m.id=auth.uid() and m.active=true
  ) then
    raise exception 'Active club membership required';
  end if;

  return query
    with visible_teams as (
      select t.team_code,t.team_name
      from public.club_teams t
      where t.active=true and (
        public.is_owner()
        or exists(select 1 from public.club_team_members own
          where own.team_code=t.team_code and own.user_id=auth.uid())
        or exists(select 1 from public.club_team_managers own
          where own.team_code=t.team_code and own.manager_id=auth.uid())
      )
    ), roster as (
      select vt.team_code,vt.team_name,m.id as user_id,
        coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text as full_name,
        m.role::text as role
      from visible_teams vt
      join public.club_team_members tm on tm.team_code=vt.team_code
      join public.members m on m.id=tm.user_id and m.active=true
      join auth.users u on u.id=m.id
      union
      select vt.team_code,vt.team_name,m.id as user_id,
        coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text as full_name,
        m.role::text as role
      from visible_teams vt
      join public.club_team_managers tm on tm.team_code=vt.team_code
      join public.members m on m.id=tm.manager_id and m.active=true and m.role='manager'
      join auth.users u on u.id=m.id
    )
    select roster.team_code,roster.team_name,roster.user_id,roster.full_name,roster.role
    from roster
    order by roster.team_name,roster.role,roster.full_name;
end;
$$;

revoke all on function public.set_portfolio_coverage(uuid,text,uuid[]),
  public.list_my_team_members() from public,anon,authenticated;
grant execute on function public.set_portfolio_coverage(uuid,text,uuid[]),
  public.list_my_team_members() to authenticated;

commit;
