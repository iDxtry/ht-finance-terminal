begin;

-- Replace the original two-code team list with owner-managed groups. Keep the
-- existing HTIG/HTQF identities and memberships intact.
create table if not exists public.club_teams (
  team_code text primary key check (team_code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  team_name text not null check (length(btrim(team_name)) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  active boolean not null default true,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.club_teams(team_code,team_name,description)
values ('HTIG','HTIG','Legacy investment group'), ('HTQF','HTQF','Legacy quantitative group')
on conflict (team_code) do nothing;

alter table public.club_team_members drop constraint if exists club_team_members_team_code_check;
alter table public.club_team_members drop constraint if exists club_team_members_team_code_fkey;
alter table public.club_team_members
  add constraint club_team_members_team_code_fkey
  foreign key (team_code) references public.club_teams(team_code) on update cascade on delete restrict;

create table if not exists public.club_team_managers (
  team_code text not null references public.club_teams(team_code) on update cascade on delete cascade,
  manager_id uuid not null references public.members(id) on delete cascade,
  assigned_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_code,manager_id)
);
create index if not exists club_team_managers_member_idx
  on public.club_team_managers(manager_id,team_code);

alter table public.club_teams enable row level security;
alter table public.club_team_managers enable row level security;
revoke all on public.club_teams,public.club_team_managers from anon,authenticated;
grant select on public.club_teams,public.club_team_managers to authenticated;

drop policy if exists club_teams_read on public.club_teams;
create policy club_teams_read on public.club_teams for select to authenticated
  using (public.is_owner()
    or exists(select 1 from public.club_team_members t join public.members m on m.id=t.user_id
      where t.team_code=club_teams.team_code and t.user_id=auth.uid() and m.active=true)
    or exists(select 1 from public.club_team_managers tm join public.members m on m.id=tm.manager_id
      where tm.team_code=club_teams.team_code and tm.manager_id=auth.uid() and m.active=true));
drop policy if exists club_team_managers_read on public.club_team_managers;
create policy club_team_managers_read on public.club_team_managers for select to authenticated
  using (public.is_owner() or exists(select 1 from public.members m where m.id=manager_id and m.id=auth.uid() and m.active=true) or exists(
    select 1 from public.club_team_members t join public.members m on m.id=t.user_id
    where t.team_code=club_team_managers.team_code and t.user_id=auth.uid() and m.active=true
  ));
drop policy if exists club_team_read on public.club_team_members;
create policy club_team_read on public.club_team_members for select to authenticated
  using (public.is_owner() or exists(select 1 from public.members own where own.id=user_id and own.id=auth.uid() and own.active=true) or exists (
    select 1 from public.portfolio_assignments a join public.members manager on manager.id=a.manager_id
    where a.portfolio_owner_id=user_id and a.manager_id=auth.uid() and manager.active=true
  ));

-- Quant members may research proposals in their own assigned group, and only
-- their own proposal/portfolio records when they have no group assignment.
create or replace function public.can_access_member_portfolio(target_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare actor_role text;
begin
  if auth.uid() is null or target_user_id is null then return false; end if;
  if public.is_owner() then return true; end if;
  select m.role into actor_role from public.members m where m.id=auth.uid() and m.active=true;
  if actor_role is null then return false; end if;
  if public.has_permission('portfolios.read_all') then return true; end if;
  if actor_role='manager' then
    return exists(select 1 from public.portfolio_assignments a
      where a.portfolio_owner_id=target_user_id and a.manager_id=auth.uid());
  end if;
  if actor_role='quant' then
    return target_user_id=auth.uid() or exists(
      select 1 from public.members intern
      join public.club_team_members intern_team on intern_team.user_id=intern.id
      join public.club_team_members quant_team on quant_team.team_code=intern_team.team_code
      join public.club_teams team on team.team_code=intern_team.team_code and team.active=true
      where intern.id=target_user_id and intern.role='intern' and intern.active=true
        and quant_team.user_id=auth.uid()
    );
  end if;
  return target_user_id=auth.uid() and public.has_permission('portfolios.read_own');
end;
$$;

create or replace function public.can_read_proposal(target_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare actor_role text;
begin
  if auth.uid() is null or target_user_id is null then return false; end if;
  if public.is_owner() then return true; end if;
  select m.role into actor_role from public.members m where m.id=auth.uid() and m.active=true;
  if actor_role is null then return false; end if;
  if actor_role='quant' then
    return (public.has_permission('proposals.read_all') and public.can_access_member_portfolio(target_user_id))
      or (target_user_id=auth.uid() and public.has_permission('proposals.read_own'));
  end if;
  if public.has_permission('portfolios.read_all') then return true; end if;
  if actor_role='manager' then return public.can_access_member_portfolio(target_user_id); end if;
  if public.has_permission('proposals.read_all') then return true; end if;
  return target_user_id=auth.uid() and public.has_permission('proposals.read_own');
end;
$$;

-- Quant write access follows the same proposal visibility boundary as reads.
create or replace function public.add_quant_analysis(
  proposal_id uuid,
  recommendation text,
  summary text,
  analysis_metrics jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare analysis_id uuid; proposal_author uuid; normalized_summary text := btrim(coalesce(summary,''));
begin
  if not public.has_permission('quant.research.write') then raise exception 'Quant research write permission required'; end if;
  if recommendation not in ('support','caution','oppose') or recommendation is null then raise exception 'Choose support, caution, or oppose'; end if;
  if length(normalized_summary)<20 or length(normalized_summary)>2000 then raise exception 'Quant summary must be 20 to 2,000 characters'; end if;
  if analysis_metrics is null or pg_catalog.jsonb_typeof(analysis_metrics)<>'object' or pg_catalog.octet_length(analysis_metrics::text)>8192 then
    raise exception 'Quant metrics must be a JSON object smaller than 8 KB';
  end if;
  select p.author_id into proposal_author from public.proposals p where p.id=proposal_id;
  if not found then raise exception 'Proposal not found'; end if;
  if not public.can_read_proposal(proposal_author) then raise exception 'This proposal is outside your assigned team'; end if;
  insert into public.quant_analyses(proposal_id,analyst_id,recommendation,summary,metrics)
    values(proposal_id,auth.uid(),recommendation,normalized_summary,analysis_metrics)
    returning id into analysis_id;
  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),'quant.analysis_added',jsonb_build_object('analysis_id',analysis_id,'proposal_id',proposal_id,'recommendation',recommendation));
  return analysis_id;
end;
$$;

create or replace function public.list_admin_teams()
returns table(team_code text,team_name text,description text,active boolean,member_count bigint,manager_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  return query
    select t.team_code,t.team_name,t.description,t.active,
      (select count(*) from public.club_team_members tm join public.members m on m.id=tm.user_id
        where tm.team_code=t.team_code and m.active=true),
      coalesce((select array_agg(link.manager_id order by link.manager_id)
        from public.club_team_managers link join public.members manager on manager.id=link.manager_id
        where link.team_code=t.team_code and manager.role='manager' and manager.active=true),'{}'::uuid[])
    from public.club_teams t order by t.team_name,t.team_code;
end;
$$;

-- Each caller can see only their own active group memberships. The RPC accepts
-- no user ID, so callers cannot use it to enumerate another member's teams.
create or replace function public.my_team_details()
returns table(team_code text,team_name text,manager_names text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.members m where m.id=auth.uid() and m.active=true) then
    raise exception 'Active club membership required';
  end if;
  return query
    with my_teams as (
      select tm.team_code from public.club_team_members tm where tm.user_id=auth.uid()
      union
      select tm.team_code from public.club_team_managers tm where tm.manager_id=auth.uid()
    )
    select t.team_code,t.team_name,
      coalesce((select array_agg(
        coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text
        order by coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text)
        from (
          select tm.manager_id from public.club_team_managers tm where tm.team_code=t.team_code
          union
          select a.manager_id from public.portfolio_assignments a
          join public.club_team_members own_team on own_team.user_id=a.portfolio_owner_id and own_team.team_code=t.team_code
          where a.portfolio_owner_id=auth.uid()
        ) assigned
        join public.members manager on manager.id=assigned.manager_id and manager.role='manager' and manager.active=true
        join auth.users u on u.id=manager.id),'{}'::text[])
    from my_teams mine join public.club_teams t on t.team_code=mine.team_code and t.active=true
    order by t.team_name,t.team_code;
end;
$$;

create or replace function public.save_club_team(p_team_code text,p_team_name text,p_description text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare normalized_code text := upper(btrim(coalesce(p_team_code,'')));
  normalized_name text := btrim(coalesce(p_team_name,'')); normalized_description text := coalesce(p_description,'');
  was_created boolean;
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  if normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then raise exception 'Group code must be 1–32 letters, numbers, underscores, or hyphens'; end if;
  if length(normalized_name) not between 1 and 80 then raise exception 'Group name must be 1–80 characters'; end if;
  if length(normalized_description)>1000 then raise exception 'Group description must be at most 1,000 characters'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  select not exists(select 1 from public.club_teams t where t.team_code=normalized_code) into was_created;
  insert into public.club_teams(team_code,team_name,description,active,created_by,updated_at)
    values(normalized_code,normalized_name,normalized_description,true,auth.uid(),now())
    on conflict(team_code) do update set team_name=excluded.team_name,
      description=excluded.description,active=true,updated_at=now();
  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),case when was_created then 'team.created' else 'team.updated' end,
      jsonb_build_object('team_code',normalized_code,'team_name',normalized_name));
end;
$$;

create or replace function public.set_member_team(p_target_user_id uuid,p_team_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_role text; normalized_code text := nullif(upper(btrim(coalesce(p_team_code,''))), '');
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  if p_target_user_id is null then raise exception 'Choose a member'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  select m.role into target_role from public.members m where m.id=p_target_user_id and m.active=true for update;
  if target_role not in ('intern','quant') or target_role is null then raise exception 'Only active Intern and Quant members can be assigned to a group'; end if;
  if normalized_code is not null and not exists(select 1 from public.club_teams t where t.team_code=normalized_code and t.active=true) then
    raise exception 'Choose an active group';
  end if;
  if normalized_code is null then
    delete from public.club_team_members where user_id=p_target_user_id;
    delete from public.portfolio_assignments where portfolio_owner_id=p_target_user_id;
  else
    insert into public.club_team_members(user_id,team_code,assigned_by,updated_at)
      values(p_target_user_id,normalized_code,auth.uid(),now())
      on conflict(user_id) do update set team_code=excluded.team_code,assigned_by=excluded.assigned_by,updated_at=now();
    delete from public.portfolio_assignments where portfolio_owner_id=p_target_user_id;
    if target_role='intern' then
      insert into public.portfolio_assignments(portfolio_owner_id,manager_id,assigned_by)
        select p_target_user_id,tm.manager_id,auth.uid()
        from public.club_team_managers tm join public.members manager on manager.id=tm.manager_id
        where tm.team_code=normalized_code and manager.role='manager' and manager.active=true;
    end if;
  end if;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'member.group_changed',p_target_user_id,jsonb_build_object('team_code',normalized_code,'role',target_role));
end;
$$;

create or replace function public.set_team_managers(p_team_code text,p_manager_user_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare normalized_code text := upper(btrim(coalesce(p_team_code,'')));
  manager_ids uuid[] := coalesce(p_manager_user_ids,'{}'::uuid[]);
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  if cardinality(manager_ids)>20 then raise exception 'Choose at most 20 group Managers'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  if not exists(select 1 from public.club_teams t where t.team_code=normalized_code and t.active=true) then
    raise exception 'Choose an active group';
  end if;
  if exists(select 1 from unnest(manager_ids) selected(manager_id)
    where selected.manager_id is null or not exists(
      select 1 from public.members m where m.id=selected.manager_id and m.role='manager' and m.active=true
    )) then raise exception 'Every group lead must be an active Manager'; end if;
  delete from public.club_team_managers where team_code=normalized_code;
  insert into public.club_team_managers(team_code,manager_id,assigned_by)
    select normalized_code,selected.manager_id,auth.uid()
    from (select distinct manager_id from unnest(manager_ids) selected(manager_id)) selected;
  -- A group's Manager list covers every active Intern in that group. Quant
  -- members can research the group, but are not treated as paper portfolios.
  delete from public.portfolio_assignments a using public.club_team_members tm,public.members intern
    where a.portfolio_owner_id=tm.user_id and tm.user_id=intern.id
      and tm.team_code=normalized_code and intern.role='intern';
  insert into public.portfolio_assignments(portfolio_owner_id,manager_id,assigned_by)
    select intern.id,selected.manager_id,auth.uid()
    from public.club_team_members tm join public.members intern on intern.id=tm.user_id and intern.role='intern' and intern.active=true
    cross join (select distinct manager_id from unnest(manager_ids) selected(manager_id)) selected
    where tm.team_code=normalized_code;
  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),'team.managers_changed',jsonb_build_object('team_code',normalized_code,'manager_ids',to_jsonb(manager_ids)));
end;
$$;

create or replace function public.set_club_team_active(p_team_code text,p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare normalized_code text := upper(btrim(coalesce(p_team_code,'')));
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  if normalized_code in ('HTIG','HTQF') and p_active is false then raise exception 'Legacy groups cannot be archived'; end if;
  if p_active is null then raise exception 'Choose whether the group is active'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  if not exists(select 1 from public.club_teams t where t.team_code=normalized_code) then raise exception 'Group not found'; end if;
  if p_active=false and (exists(select 1 from public.club_team_members tm where tm.team_code=normalized_code)
    or exists(select 1 from public.club_team_managers tm where tm.team_code=normalized_code)) then
    raise exception 'Reassign group members and Managers before archiving this group';
  end if;
  update public.club_teams set active=p_active,updated_at=now() where team_code=normalized_code;
  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),case when p_active then 'team.reactivated' else 'team.archived' end,jsonb_build_object('team_code',normalized_code));
end;
$$;

-- Keep the existing per-member coverage RPC working for HTIG/HTQF and allow
-- the Owner to use it for newly created groups while the UI transitions.
create or replace function public.set_portfolio_coverage(target_user_id uuid, team_code text, manager_user_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare target_role text; manager_ids uuid[] := coalesce(manager_user_ids,'{}'::uuid[]); normalized_code text := upper(btrim(coalesce(team_code,'')));
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  if not exists(select 1 from public.club_teams t where t.team_code=normalized_code and t.active=true) then raise exception 'Choose an active group'; end if;
  select m.role into target_role from public.members m where m.id=target_user_id and m.active=true;
  if target_role not in ('intern','quant') or target_role is null then raise exception 'Assign a group to an active Intern or Quant member'; end if;
  if cardinality(manager_ids)>20 then raise exception 'Choose at most 20 portfolio managers'; end if;
  if target_role='quant' and cardinality(manager_ids)>0 then raise exception 'Quant members are assigned to groups, not intern portfolios'; end if;
  if exists(select 1 from unnest(manager_ids) selected(manager_id)
    where selected.manager_id is null or not exists(
      select 1 from public.members m where m.id=selected.manager_id and m.role='manager' and m.active=true
    )) then raise exception 'Every portfolio manager must be an active Manager'; end if;
  insert into public.club_team_members(user_id,team_code,assigned_by,updated_at)
    values(target_user_id,normalized_code,auth.uid(),now())
    on conflict(user_id) do update set team_code=excluded.team_code,assigned_by=excluded.assigned_by,updated_at=now();
  delete from public.portfolio_assignments where portfolio_owner_id=target_user_id;
  insert into public.portfolio_assignments(portfolio_owner_id,manager_id,assigned_by)
    select target_user_id,selected.manager_id,auth.uid()
    from (select distinct manager_id from unnest(manager_ids) selected(manager_id)) selected;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'portfolio.coverage_changed',target_user_id,
      jsonb_build_object('team',normalized_code,'manager_ids',to_jsonb(manager_ids)));
end;
$$;

create or replace function public.set_member_role(target_user_id uuid, assigned_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare previous_role text; active_owners integer;
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  if target_user_id is null or assigned_role not in ('owner','manager','intern','quant') or assigned_role is null then raise exception 'Choose a supported club role'; end if;
  if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'That account has not signed in or accepted its invitation'; end if;
  select role into previous_role from public.members where id=target_user_id and active=true;
  select count(*) into active_owners from public.members where role='owner' and active=true;
  if previous_role='owner' and assigned_role<>'owner' and active_owners<=1 then raise exception 'The club must keep at least one active Owner'; end if;
  if previous_role='manager' and assigned_role<>'manager' then
    delete from public.portfolio_assignments where manager_id=target_user_id;
    delete from public.club_team_managers where manager_id=target_user_id;
  end if;
  if assigned_role<>'intern' then delete from public.portfolio_assignments where portfolio_owner_id=target_user_id; end if;
  if assigned_role not in ('intern','quant') then delete from public.club_team_members where user_id=target_user_id; end if;
  insert into public.members(id,role,active) values(target_user_id,assigned_role,true)
    on conflict(id) do update set role=excluded.role,active=true;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'member.role_changed',target_user_id,jsonb_build_object('from',previous_role,'to',assigned_role));
end;
$$;

create or replace function public.remove_member(target_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_role text; active_owners integer;
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  select role into target_role from public.members where id=target_user_id and active=true for update;
  if target_role is null then raise exception 'Member is already inactive or missing'; end if;
  select count(*) into active_owners from public.members where role='owner' and active=true;
  if target_role='owner' and active_owners<=1 then raise exception 'The club must keep at least one active Owner'; end if;
  update public.members set active=false where id=target_user_id;
  delete from public.club_team_managers where manager_id=target_user_id;
  delete from public.portfolio_assignments where portfolio_owner_id=target_user_id or manager_id=target_user_id;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'member.access_removed',target_user_id,jsonb_build_object('role',target_role));
end;
$$;

create or replace function public.assign_invited_member(target_user_id uuid, assigned_role text, owner_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare previous_role text;
begin
  if not exists(select 1 from public.members where id=owner_user_id and role='owner' and active=true) then raise exception 'Owner access required'; end if;
  if assigned_role not in ('owner','manager','intern','quant') or assigned_role is null then raise exception 'Choose a supported club role'; end if;
  if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'Invited account not found'; end if;
  select role into previous_role from public.members where id=target_user_id and active=true;
  if previous_role='manager' and assigned_role<>'manager' then
    delete from public.portfolio_assignments where manager_id=target_user_id;
    delete from public.club_team_managers where manager_id=target_user_id;
  end if;
  if assigned_role<>'intern' then delete from public.portfolio_assignments where portfolio_owner_id=target_user_id; end if;
  if assigned_role not in ('intern','quant') then delete from public.club_team_members where user_id=target_user_id; end if;
  insert into public.members(id,role,active) values(target_user_id,assigned_role,true)
    on conflict(id) do update set role=excluded.role,active=true;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(owner_user_id,'member.invited',target_user_id,jsonb_build_object('role',assigned_role));
end;
$$;

revoke all on function public.list_admin_teams(),
  public.my_team_details(),
  public.save_club_team(text,text,text),public.set_member_team(uuid,text),public.set_team_managers(text,uuid[]),
  public.set_club_team_active(text,boolean),public.set_portfolio_coverage(uuid,text,uuid[]),
  public.set_member_role(uuid,text),public.remove_member(uuid),public.assign_invited_member(uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.list_admin_teams(),public.my_team_details(),public.save_club_team(text,text,text),
  public.set_member_team(uuid,text),public.set_team_managers(text,uuid[]),public.set_club_team_active(text,boolean),
  public.set_portfolio_coverage(uuid,text,uuid[]),public.set_member_role(uuid,text),public.remove_member(uuid)
  to authenticated;
grant execute on function public.assign_invited_member(uuid,text,uuid) to service_role;
revoke all on function public.can_access_member_portfolio(uuid),public.can_read_proposal(uuid),
  public.add_quant_analysis(uuid,text,text,jsonb) from public,anon;
grant execute on function public.can_access_member_portfolio(uuid),public.can_read_proposal(uuid),
  public.add_quant_analysis(uuid,text,text,jsonb) to authenticated;

commit;
