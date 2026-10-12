begin;

-- Reconcile assignments created before groups became mandatory. Only an
-- active Manager explicitly linked to an active group may oversee an active
-- Intern in that same group.
insert into public.audit_log(actor_id,action,target_user_id,details)
select null,'portfolio.assignment_removed_by_migration',a.portfolio_owner_id,
  jsonb_build_object('manager_id',a.manager_id,'reason','assignment did not match an active group Manager')
from public.portfolio_assignments a
where not exists (
  select 1
  from public.members intern
  join public.club_team_members intern_team on intern_team.user_id=intern.id
  join public.club_teams team on team.team_code=intern_team.team_code and team.active=true
  join public.club_team_managers manager_team on manager_team.team_code=team.team_code
  join public.members manager on manager.id=manager_team.manager_id
  where intern.id=a.portfolio_owner_id and intern.role='intern' and intern.active=true
    and manager.id=a.manager_id and manager.role='manager' and manager.active=true
);
delete from public.portfolio_assignments a
where not exists (
  select 1
  from public.members intern
  join public.club_team_members intern_team on intern_team.user_id=intern.id
  join public.club_teams team on team.team_code=intern_team.team_code and team.active=true
  join public.club_team_managers manager_team on manager_team.team_code=team.team_code
  join public.members manager on manager.id=manager_team.manager_id
  where intern.id=a.portfolio_owner_id and intern.role='intern' and intern.active=true
    and manager.id=a.manager_id and manager.role='manager' and manager.active=true
);

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
    return exists (
      select 1
      from public.portfolio_assignments a
      join public.members intern on intern.id=a.portfolio_owner_id and intern.role='intern' and intern.active=true
      join public.club_team_members intern_team on intern_team.user_id=intern.id
      join public.club_teams team on team.team_code=intern_team.team_code and team.active=true
      join public.club_team_managers manager_team on manager_team.team_code=team.team_code
      where a.portfolio_owner_id=target_user_id
        and a.manager_id=auth.uid()
        and manager_team.manager_id=auth.uid()
    );
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

drop policy if exists portfolio_assignment_read on public.portfolio_assignments;
create policy portfolio_assignment_read on public.portfolio_assignments for select to authenticated
  using (public.is_owner() or portfolio_owner_id=auth.uid()
    or (manager_id=auth.uid() and public.can_access_member_portfolio(portfolio_owner_id)));

drop policy if exists club_team_read on public.club_team_members;
create policy club_team_read on public.club_team_members for select to authenticated
  using (public.is_owner() or user_id=auth.uid() or public.can_access_member_portfolio(user_id));

create or replace function public.list_club_members()
returns table(user_id uuid,email text,full_name text,role text,joined_at timestamptz,team text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission('members.read') then raise exception 'Member roster access required'; end if;
  return query
    select u.id,u.email::text,
      coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text,
      m.role::text,u.created_at::timestamptz,t.team_code::text
    from auth.users u
    join public.members m on m.id=u.id
    left join public.club_team_members t on t.user_id=m.id
    where m.active and (public.is_owner() or u.id=auth.uid() or public.can_access_member_portfolio(m.id))
    order by u.created_at desc;
end;
$$;

-- A shared Postgres counter keeps the guest limit consistent across Edge
-- Function isolates. Store only a SHA-256 client-key hash, never an IP address.
create table if not exists public.market_request_limits (
  bucket_kind text not null check (bucket_kind in ('client','global')),
  bucket_key text not null,
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key(bucket_kind,bucket_key,window_start),
  check ((bucket_kind='client' and bucket_key ~ '^[a-f0-9]{64}$') or (bucket_kind='global' and bucket_key='all'))
);
alter table public.market_request_limits enable row level security;
revoke all on public.market_request_limits from public,anon,authenticated;

drop function if exists public.consume_guest_market_request(text,integer);
create or replace function public.consume_market_request_budget(
  p_client_hash text,
  p_is_guest boolean,
  p_cost integer default 1,
  p_client_limit integer default 30,
  p_global_limit integer default 180
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_window_start timestamptz := date_trunc('minute',clock_timestamp());
  current_client_count integer := 0; current_global_count integer := 0;
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then
    raise exception using errcode='42501',message='Service role required';
  end if;
  if p_is_guest is null or (p_is_guest and (p_client_hash is null or p_client_hash !~ '^[a-f0-9]{64}$')) then
    raise exception using errcode='22023',message='Invalid client key';
  end if;
  if p_cost is null or p_cost<0 or p_cost>3
    or p_client_limit is null or p_client_limit<1 or p_client_limit>120
    or p_global_limit is null or p_global_limit<1 or p_global_limit>200 then
    raise exception using errcode='22023',message='Invalid request limit';
  end if;

  -- Serialize the small counter transaction so concurrent isolates cannot
  -- race past either threshold. The global bucket also limits distributed IPs.
  perform pg_catalog.pg_advisory_xact_lock(874312655,1);
  delete from public.market_request_limits l where l.window_start<v_window_start-interval '1 minute';
  select l.request_count into current_global_count from public.market_request_limits l
    where l.bucket_kind='global' and l.bucket_key='all' and l.window_start=v_window_start;
  if p_is_guest then
    select l.request_count into current_client_count from public.market_request_limits l
      where l.bucket_kind='client' and l.bucket_key=p_client_hash and l.window_start=v_window_start;
  end if;
  if coalesce(current_global_count,0)+p_cost>p_global_limit
    or (p_is_guest and coalesce(current_client_count,0)>=p_client_limit) then
    return false;
  end if;

  if p_cost>0 then
    insert into public.market_request_limits(bucket_kind,bucket_key,window_start,request_count)
      values('global','all',v_window_start,p_cost)
      on conflict(bucket_kind,bucket_key,window_start) do update
        set request_count=public.market_request_limits.request_count+excluded.request_count;
  end if;
  if p_is_guest then
    insert into public.market_request_limits(bucket_kind,bucket_key,window_start,request_count)
      values('client',p_client_hash,v_window_start,1)
      on conflict(bucket_kind,bucket_key,window_start) do update
        set request_count=public.market_request_limits.request_count+1;
  end if;
  return true;
end;
$$;
revoke all on function public.consume_market_request_budget(text,boolean,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_market_request_budget(text,boolean,integer,integer,integer) to service_role;

commit;
