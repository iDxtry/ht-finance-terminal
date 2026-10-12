begin;

-- Expand the existing schema without replacing member identities or trade history.
alter table public.members add column if not exists active boolean not null default true;
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check
  check (role in ('owner', 'manager', 'intern', 'quant'));

alter table public.proposals add column if not exists entry_price numeric
  check (entry_price is null or (entry_price > 0 and entry_price < 100000000));
alter table public.proposals add column if not exists target_price numeric
  check (target_price is null or (target_price > 0 and target_price < 100000000));
alter table public.proposals add column if not exists stop_loss numeric
  check (stop_loss is null or (stop_loss > 0 and stop_loss < 100000000));
alter table public.proposals add column if not exists time_horizon text
  check (time_horizon is null or time_horizon in ('intraday','swing','short-term','long-term'));
alter table public.proposals add column if not exists allocation_pct numeric
  check (allocation_pct is null or (allocation_pct > 0 and allocation_pct <= 100));
alter table public.proposals add column if not exists research_url text
  check (research_url is null or (length(research_url) <= 2048 and research_url ~* '^https://'));
alter table public.proposals add column if not exists manager_comment text
  check (manager_comment is null or length(manager_comment) <= 2000);
alter table public.proposals drop constraint if exists proposals_price_levels_order_check;
alter table public.proposals add constraint proposals_price_levels_order_check check (
  (entry_price is null and target_price is null and stop_loss is null)
  or (entry_price is not null and target_price is not null and stop_loss is not null and (
    (side='buy' and stop_loss<entry_price and entry_price<target_price)
    or (side='sell' and target_price<entry_price and entry_price<stop_loss)
  ))
);

create table if not exists public.proposal_reviews (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  reviewer_id uuid not null references public.members(id),
  decision text not null check (decision in ('approved','rejected')),
  is_override boolean not null default false,
  comment text not null default '' check (length(comment) <= 2000),
  created_at timestamptz not null default now()
);
alter table public.proposal_reviews add column if not exists is_override boolean not null default false;
create index if not exists proposal_reviews_proposal_created_idx
  on public.proposal_reviews(proposal_id,created_at desc);
alter table public.proposal_reviews enable row level security;
revoke all on public.proposal_reviews from anon,authenticated;
grant select on public.proposal_reviews to authenticated;

create table if not exists public.quant_analyses (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  analyst_id uuid not null references public.members(id),
  recommendation text not null check (recommendation in ('support','caution','oppose')),
  summary text not null check (length(summary) between 20 and 2000),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics)='object'),
  created_at timestamptz not null default now()
);
create index if not exists quant_analyses_proposal_created_idx
  on public.quant_analyses(proposal_id,created_at desc);
alter table public.quant_analyses enable row level security;
revoke all on public.quant_analyses from anon,authenticated;
grant select on public.quant_analyses to authenticated;
grant insert(author_id,symbol,side,quantity,thesis,risks,entry_price,target_price,stop_loss,
  time_horizon,allocation_pct,research_url) on public.proposals to authenticated;

create table if not exists public.user_permissions (
  user_id uuid not null references public.members(id) on delete cascade,
  permission_key text not null check (permission_key in (
    'members.read','members.manage','permissions.manage','audit.read',
    'proposals.create','proposals.read_own','proposals.read_all','proposals.review',
    'paper_trades.read_own','paper_trades.read_all','paper_trades.execute',
    'portfolios.read_own','portfolios.read_assigned','portfolios.read_all',
    'market_data.read','research.read','quant.research.write',
    'quant.experiments.run','quant.experiments.read','settings.manage'
  )),
  effect text not null check (effect in ('allow','deny')),
  granted_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.members(id) on delete set null,
  action text not null check (length(action) between 1 and 100),
  target_user_id uuid references auth.users(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log(created_at desc);
create index if not exists audit_log_target_idx on public.audit_log(target_user_id,created_at desc);

create table if not exists public.club_team_members (
  user_id uuid primary key references public.members(id) on delete cascade,
  team_code text not null check (team_code in ('HTIG','HTQF')),
  assigned_by uuid references public.members(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table if not exists public.portfolio_assignments (
  portfolio_owner_id uuid not null references public.members(id) on delete cascade,
  manager_id uuid not null references public.members(id) on delete cascade,
  assigned_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (portfolio_owner_id,manager_id),
  check (portfolio_owner_id<>manager_id)
);
create index if not exists portfolio_assignments_manager_idx on public.portfolio_assignments(manager_id,portfolio_owner_id);
create table if not exists public.watchlists (
  user_id uuid primary key references public.members(id) on delete cascade,
  symbols text[] not null default '{}'::text[] check (cardinality(symbols)<=30),
  updated_at timestamptz not null default now()
);
alter table public.club_team_members enable row level security;
alter table public.portfolio_assignments enable row level security;
alter table public.watchlists enable row level security;
revoke all on public.club_team_members,public.portfolio_assignments,public.watchlists from anon,authenticated;
grant select on public.club_team_members,public.portfolio_assignments to authenticated;
grant select,insert,update on public.watchlists to authenticated;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.members m where m.id=auth.uid() and m.role='owner' and m.active=true)
$$;

create or replace function public.has_permission(permission_key text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  member_role text;
  override_effect text;
begin
  if auth.uid() is null or permission_key is null then return false; end if;
  select m.role into member_role from public.members m
  where m.id=auth.uid() and m.active=true;
  if member_role is null then return false; end if;
  if member_role='owner' then return true; end if;
  select p.effect into override_effect from public.user_permissions p
  where p.user_id=auth.uid() and p.permission_key=has_permission.permission_key;
  if override_effect='deny' then return false; end if;
  if override_effect='allow' then return true; end if;
  return case member_role
    when 'manager' then permission_key=any(array[
      'members.read','proposals.read_all','proposals.review','paper_trades.read_all',
      'paper_trades.execute','portfolios.read_assigned','market_data.read',
      'research.read','quant.experiments.read']::text[])
    when 'intern' then permission_key=any(array[
      'proposals.create','proposals.read_own','paper_trades.read_own',
      'portfolios.read_own','market_data.read','research.read']::text[])
    when 'quant' then permission_key=any(array[
      'proposals.read_all','paper_trades.read_all','portfolios.read_assigned',
      'market_data.read','research.read','quant.research.write',
      'quant.experiments.run','quant.experiments.read']::text[])
    else false
  end;
end;
$$;

create or replace function public.can_access_member_portfolio(target_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare actor_role text;
begin
  if auth.uid() is null or target_user_id is null then return false; end if;
  if public.is_owner() then return true; end if;
  select role into actor_role from public.members where id=auth.uid() and active=true;
  if actor_role is null then return false; end if;
  if public.has_permission('portfolios.read_all') then return true; end if;
  if actor_role='manager' then
    return exists(select 1 from public.portfolio_assignments a
      where a.portfolio_owner_id=target_user_id and a.manager_id=auth.uid());
  end if;
  if actor_role='quant' then
    return target_user_id=auth.uid() or exists(
      select 1 from public.members m join public.club_team_members t on t.user_id=m.id
      where m.id=target_user_id and m.role='intern' and m.active=true and t.team_code='HTQF'
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
  select role into actor_role from public.members where id=auth.uid() and active=true;
  if actor_role is null then return false; end if;
  if actor_role='quant' and public.has_permission('proposals.read_all') then return true; end if;
  if public.has_permission('portfolios.read_all') then return true; end if;
  if actor_role='manager' then return public.can_access_member_portfolio(target_user_id); end if;
  if public.has_permission('proposals.read_all') then return true; end if;
  return target_user_id=auth.uid() and public.has_permission('proposals.read_own');
end;
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_permission('proposals.review')
$$;

create or replace function public.my_permissions()
returns text[] language sql stable security definer set search_path = '' as $$
  with member_role as (
    select role from public.members where id=auth.uid() and active=true
  ),
  defaults(permission_key) as (
    select unnest(case role
      when 'owner' then array[
        'members.read','members.manage','permissions.manage','audit.read',
        'proposals.create','proposals.read_own','proposals.read_all','proposals.review',
        'paper_trades.read_own','paper_trades.read_all','paper_trades.execute',
        'portfolios.read_own','portfolios.read_assigned','portfolios.read_all',
        'market_data.read','research.read','quant.research.write',
        'quant.experiments.run','quant.experiments.read','settings.manage']::text[]
      when 'manager' then array[
        'members.read','proposals.read_all','proposals.review','paper_trades.read_all',
        'paper_trades.execute','portfolios.read_assigned','market_data.read',
        'research.read','quant.experiments.read']::text[]
      when 'intern' then array[
        'proposals.create','proposals.read_own','paper_trades.read_own',
        'portfolios.read_own','market_data.read','research.read']::text[]
      when 'quant' then array[
        'proposals.read_all','paper_trades.read_all','portfolios.read_assigned',
        'market_data.read','research.read','quant.research.write',
        'quant.experiments.run','quant.experiments.read']::text[]
      else array[]::text[] end)
    from member_role
  ),
  allows(permission_key) as (
    select permission_key from defaults
    union
    select permission_key from public.user_permissions
    where user_id=auth.uid() and effect='allow'
  )
  select coalesce(array_agg(a.permission_key order by a.permission_key),array[]::text[])
  from allows a
  where public.is_owner() or not exists (
      select 1 from public.user_permissions p
      where p.user_id=auth.uid() and p.effect='deny' and p.permission_key=a.permission_key
    )
$$;

drop policy if exists proposal_review_read on public.proposal_reviews;
create policy proposal_review_read on public.proposal_reviews for select to authenticated
  using (exists (
    select 1 from public.proposals p
    where p.id=proposal_id and (
      (p.author_id=auth.uid() and public.has_permission('proposals.read_own'))
      or (public.has_permission('proposals.read_all') and public.can_read_proposal(p.author_id))
    )
  ));
drop policy if exists quant_analysis_read on public.quant_analyses;
create policy quant_analysis_read on public.quant_analyses for select to authenticated
  using (exists (
    select 1 from public.proposals p
    where p.id=proposal_id and public.can_read_proposal(p.author_id)
      and (public.is_owner() or public.has_permission('quant.experiments.read')
        or public.has_permission('quant.research.write'))
  ));

alter table public.user_permissions enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.user_permissions,public.audit_log from anon,authenticated;
grant select on public.user_permissions,public.audit_log to authenticated;
drop policy if exists owner_permission_read on public.user_permissions;
create policy owner_permission_read on public.user_permissions
  for select to authenticated using (public.is_owner());
drop policy if exists owner_audit_read on public.audit_log;
create policy owner_audit_read on public.audit_log
  for select to authenticated using (public.is_owner());
drop policy if exists portfolio_assignment_read on public.portfolio_assignments;
create policy portfolio_assignment_read on public.portfolio_assignments for select to authenticated
  using (public.is_owner() or manager_id=auth.uid() or portfolio_owner_id=auth.uid());
drop policy if exists club_team_read on public.club_team_members;
create policy club_team_read on public.club_team_members for select to authenticated
  using (public.is_owner() or user_id=auth.uid() or exists (
    select 1 from public.portfolio_assignments a
    where a.portfolio_owner_id=user_id and a.manager_id=auth.uid()
  ));
drop policy if exists watchlist_self_access on public.watchlists;
create policy watchlist_self_access on public.watchlists for all to authenticated
  using (user_id=auth.uid() and public.has_permission('market_data.read'))
  with check (user_id=auth.uid() and public.has_permission('market_data.read'));

drop policy if exists member_read on public.members;
create policy member_read on public.members for select to authenticated
  using ((id=auth.uid() and active) or public.is_owner());
drop policy if exists proposal_read on public.proposals;
create policy proposal_read on public.proposals for select to authenticated
  using ((author_id=auth.uid() and public.has_permission('proposals.read_own'))
      or (public.has_permission('proposals.read_all') and public.can_read_proposal(author_id)));
drop policy if exists proposal_insert on public.proposals;
create policy proposal_insert on public.proposals for insert to authenticated
  with check (author_id=auth.uid() and public.has_permission('proposals.create')
      and status='pending' and reviewed_by is null and reviewed_at is null);
drop policy if exists trade_read on public.trades;
create policy trade_read on public.trades for select to authenticated
  using ((author_id=auth.uid() and public.has_permission('paper_trades.read_own'))
      or (public.has_permission('paper_trades.read_all') and public.can_access_member_portfolio(author_id)));

drop function if exists public.review_proposal(uuid,text);
create or replace function public.review_proposal(proposal_id uuid, decision text, manager_comment text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare normalized_comment text := coalesce(manager_comment,''); proposal_author uuid;
begin
  if not public.has_permission('proposals.review') then raise exception 'Proposal review permission required'; end if;
  if decision not in ('approved','rejected') or decision is null then raise exception 'Invalid decision'; end if;
  if length(normalized_comment)>2000 then raise exception 'Review comment is too long'; end if;
  select author_id into proposal_author from public.proposals where id=proposal_id for update;
  if not found then raise exception 'Proposal already reviewed or missing'; end if;
  if not public.can_access_member_portfolio(proposal_author) then raise exception 'This proposal is outside your assigned portfolios'; end if;
  update public.proposals set status=decision,reviewed_by=auth.uid(),reviewed_at=now(),manager_comment=normalized_comment
    where id=proposal_id and status='pending';
  if not found then raise exception 'Proposal already reviewed or missing'; end if;
  insert into public.proposal_reviews(proposal_id,reviewer_id,decision,comment)
    values(proposal_id,auth.uid(),decision,normalized_comment);
  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),'proposal.reviewed',jsonb_build_object('proposal_id',proposal_id,'decision',decision,'has_comment',normalized_comment<>''));
end;
$$;

create or replace function public.override_proposal(proposal_id uuid, decision text, manager_comment text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare normalized_comment text := coalesce(manager_comment,''); current_status text;
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  if decision not in ('approved','rejected') or decision is null then raise exception 'Invalid decision'; end if;
  if length(normalized_comment)>2000 then raise exception 'Override comment is too long'; end if;
  select status into current_status from public.proposals where id=proposal_id for update;
  if not found then raise exception 'Proposal not found'; end if;
  if current_status='executed' then raise exception 'An executed paper fill cannot be overridden'; end if;
  update public.proposals set status=decision,reviewed_by=auth.uid(),reviewed_at=now(),manager_comment=normalized_comment
    where id=proposal_id;
  insert into public.proposal_reviews(proposal_id,reviewer_id,decision,is_override,comment)
    values(proposal_id,auth.uid(),decision,true,normalized_comment);
  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),'proposal.overridden',jsonb_build_object('proposal_id',proposal_id,'from',current_status,'to',decision,'has_comment',normalized_comment<>''));
end;
$$;

create or replace function public.add_quant_analysis(
  proposal_id uuid,
  recommendation text,
  summary text,
  analysis_metrics jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare analysis_id uuid; normalized_summary text := btrim(coalesce(summary,''));
begin
  if not public.has_permission('quant.research.write') then raise exception 'Quant research write permission required'; end if;
  if recommendation not in ('support','caution','oppose') or recommendation is null then raise exception 'Choose support, caution, or oppose'; end if;
  if length(normalized_summary)<20 or length(normalized_summary)>2000 then raise exception 'Quant summary must be 20 to 2,000 characters'; end if;
  if analysis_metrics is null or pg_catalog.jsonb_typeof(analysis_metrics)<>'object' or pg_catalog.octet_length(analysis_metrics::text)>8192 then
    raise exception 'Quant metrics must be a JSON object smaller than 8 KB';
  end if;
  if not exists(select 1 from public.proposals p where p.id=proposal_id) then raise exception 'Proposal not found'; end if;
  insert into public.quant_analyses(proposal_id,analyst_id,recommendation,summary,metrics)
    values(proposal_id,auth.uid(),recommendation,normalized_summary,analysis_metrics)
    returning id into analysis_id;
  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),'quant.analysis_added',jsonb_build_object('analysis_id',analysis_id,'proposal_id',proposal_id,'recommendation',recommendation));
  return analysis_id;
end;
$$;

create or replace function public.execute_proposal(proposal_id uuid, fill_price numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.proposals;
begin
  if not public.has_permission('paper_trades.execute') then raise exception 'Paper-trade execution permission required'; end if;
  if fill_price is null or fill_price<=0 or fill_price>=100000000 or fill_price='NaN'::numeric then raise exception 'Invalid fill price'; end if;
  select * into p from public.proposals where id=proposal_id for update;
  if not found or p.status<>'approved' then raise exception 'An approved, unexecuted proposal is required'; end if;
  if not public.can_access_member_portfolio(p.author_id) then raise exception 'This portfolio is not assigned to you'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p.author_id::text,0));
  if p.side='buy' then
    if p.quantity*fill_price > 100000-coalesce((select sum(case when side='buy' then quantity*price else -quantity*price end) from public.trades where author_id=p.author_id),0) then
      raise exception 'This paper account does not have enough cash for that fill';
    end if;
  else
    if p.quantity > coalesce((select sum(case when side='buy' then quantity else -quantity end) from public.trades where author_id=p.author_id and symbol=p.symbol),0) then
      raise exception 'This paper account does not hold enough shares to sell';
    end if;
  end if;
  insert into public.trades(proposal_id,author_id,executed_by,symbol,side,quantity,price)
    values(p.id,p.author_id,auth.uid(),p.symbol,p.side,p.quantity,fill_price);
  update public.proposals set status='executed' where id=p.id;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'paper_trade.executed',p.author_id,
      jsonb_build_object('proposal_id',p.id,'symbol',p.symbol,'side',p.side,'quantity',p.quantity,'price',fill_price));
end;
$$;

drop function if exists public.list_club_members();
create function public.list_club_members()
returns table(user_id uuid,email text,full_name text,role text,joined_at timestamptz,team text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission('members.read') then raise exception 'Member roster access required'; end if;
  return query
    select u.id,u.email::text,
      coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text,
      m.role::text,u.created_at::timestamptz,t.team_code::text
    from auth.users u join public.members m on m.id=u.id
    left join public.club_team_members t on t.user_id=m.id
    where m.active and (public.is_owner() or u.id=auth.uid() or exists(
      select 1 from public.portfolio_assignments a
      where a.portfolio_owner_id=m.id and a.manager_id=auth.uid()
    ))
    order by u.created_at desc;
end;
$$;

create or replace function public.list_proposal_authors()
returns table(user_id uuid,full_name text,role text,team text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission('proposals.read_all') and not public.has_permission('proposals.read_own') then
    raise exception 'Proposal access required';
  end if;
  return query
    select m.id,
      coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text,
      m.role::text,t.team_code::text
    from public.members m
    join auth.users u on u.id=m.id
    left join public.club_team_members t on t.user_id=m.id
    where m.active and (
      exists(select 1 from public.proposals p where p.author_id=m.id and public.can_read_proposal(p.author_id))
      or exists(select 1 from public.proposals p where p.reviewed_by=m.id and public.can_read_proposal(p.author_id))
      or exists(select 1 from public.proposal_reviews r join public.proposals p on p.id=r.proposal_id
        where r.reviewer_id=m.id and public.can_read_proposal(p.author_id))
      or exists(select 1 from public.quant_analyses q join public.proposals p on p.id=q.proposal_id
        where q.analyst_id=m.id and public.can_read_proposal(p.author_id))
      or exists(select 1 from public.trades tr where tr.executed_by=m.id and public.can_access_member_portfolio(tr.author_id))
    )
    order by full_name;
end;
$$;

create or replace function public.list_visible_portfolios()
returns table(user_id uuid,full_name text,role text,team text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission('portfolios.read_own')
    and not public.has_permission('portfolios.read_assigned')
    and not public.has_permission('portfolios.read_all') then
    raise exception 'Portfolio access required';
  end if;
  return query
    select m.id,
      coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text,
      m.role::text,t.team_code::text
    from public.members m
    join auth.users u on u.id=m.id
    left join public.club_team_members t on t.user_id=m.id
    where m.active and (m.role='intern' or m.id=auth.uid())
      and public.can_access_member_portfolio(m.id)
    order by full_name;
end;
$$;

create or replace function public.list_admin_members()
returns table(user_id uuid,email text,full_name text,role text,active boolean,joined_at timestamptz,permissions jsonb,team text,assigned_manager_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  return query
    select u.id,u.email::text,
      coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',split_part(u.email,'@',1))::text,
      m.role::text,coalesce(m.active,false),u.created_at::timestamptz,
      coalesce((select jsonb_object_agg(p.permission_key,p.effect) from public.user_permissions p where p.user_id=u.id),'{}'::jsonb),
      t.team_code::text,
      coalesce((select array_agg(a.manager_id order by a.manager_id) from public.portfolio_assignments a where a.portfolio_owner_id=u.id),'{}'::uuid[])
    from auth.users u left join public.members m on m.id=u.id
    left join public.club_team_members t on t.user_id=u.id
    order by (m.id is null),u.created_at desc;
end;
$$;

create or replace function public.set_portfolio_coverage(target_user_id uuid, team_code text, manager_user_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare target_role text; manager_ids uuid[] := coalesce(manager_user_ids,'{}'::uuid[]);
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  if team_code not in ('HTIG','HTQF') or team_code is null then raise exception 'Choose HTIG or HTQF'; end if;
  select role into target_role from public.members where id=target_user_id and active=true;
  if target_role not in ('intern','quant') or target_role is null then raise exception 'Assign a team to an active Intern or Quant member'; end if;
  if cardinality(manager_ids)>20 then raise exception 'Choose at most 20 portfolio managers'; end if;
  if target_role='quant' and cardinality(manager_ids)>0 then raise exception 'Quant members are assigned to HTQF, not intern portfolios'; end if;
  if target_role='quant' and team_code<>'HTQF' then raise exception 'Quant members must be assigned to HTQF'; end if;
  if exists(select 1 from unnest(manager_ids) as selected(manager_id)
    where selected.manager_id is null or not exists(
      select 1 from public.members m where m.id=selected.manager_id and m.role='manager' and m.active=true
    )) then raise exception 'Every portfolio manager must be an active Manager'; end if;
  insert into public.club_team_members(user_id,team_code,assigned_by,updated_at)
    values(target_user_id,team_code,auth.uid(),now())
    on conflict(user_id) do update set team_code=excluded.team_code,assigned_by=excluded.assigned_by,updated_at=now();
  delete from public.portfolio_assignments where portfolio_owner_id=target_user_id;
  insert into public.portfolio_assignments(portfolio_owner_id,manager_id,assigned_by)
    select target_user_id,selected.manager_id,auth.uid()
    from (select distinct manager_id from unnest(manager_ids) as selected(manager_id)) selected;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'portfolio.coverage_changed',target_user_id,
      jsonb_build_object('team',team_code,'manager_ids',to_jsonb(manager_ids)));
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
  end if;
  if assigned_role<>'intern' then
    delete from public.portfolio_assignments where portfolio_owner_id=target_user_id;
  end if;
  if assigned_role not in ('intern','quant') then
    delete from public.club_team_members where user_id=target_user_id;
  end if;
  insert into public.members(id,role,active) values(target_user_id,assigned_role,true)
    on conflict(id) do update set role=excluded.role,active=true;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'member.role_changed',target_user_id,jsonb_build_object('from',previous_role,'to',assigned_role));
end;
$$;

create or replace function public.set_user_permission(target_user_id uuid, permission_key text, effect text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_role text;
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  select role into target_role from public.members where id=target_user_id and active=true;
  if target_role is null then raise exception 'Choose an active club member'; end if;
  if target_role='owner' then raise exception 'Owner permissions are fixed by the Owner role'; end if;
  if permission_key not in (
    'members.read','members.manage','permissions.manage','audit.read',
    'proposals.create','proposals.read_own','proposals.read_all','proposals.review',
    'paper_trades.read_own','paper_trades.read_all','paper_trades.execute',
    'portfolios.read_own','portfolios.read_assigned','portfolios.read_all',
    'market_data.read','research.read','quant.research.write',
    'quant.experiments.run','quant.experiments.read','settings.manage'
  ) then raise exception 'Unsupported permission'; end if;
  if permission_key in ('members.manage','permissions.manage','audit.read','settings.manage') then
    raise exception 'This permission is reserved for Owner accounts';
  end if;
  if effect is null or effect='none' then
    delete from public.user_permissions p where p.user_id=target_user_id and p.permission_key=set_user_permission.permission_key;
  elsif effect in ('allow','deny') then
    insert into public.user_permissions(user_id,permission_key,effect,granted_by)
      values(target_user_id,permission_key,effect,auth.uid())
      on conflict(user_id,permission_key) do update set effect=excluded.effect,granted_by=excluded.granted_by,created_at=now();
  else
    raise exception 'Choose allow, deny, or none';
  end if;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'member.permission_changed',target_user_id,
      jsonb_build_object('permission',permission_key,'effect',coalesce(effect,'none')));
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
  delete from public.portfolio_assignments where portfolio_owner_id=target_user_id or manager_id=target_user_id;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(auth.uid(),'member.access_removed',target_user_id,jsonb_build_object('role',target_role));
end;
$$;

-- The owner-admin Edge Function checks the authenticated email against its
-- server-only INITIAL_OWNER_EMAIL setting before calling this one-time RPC.
create or replace function public.bootstrap_initial_owner(target_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owner_count integer; existing_role text;
begin
  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  select count(*) into owner_count from public.members where role='owner' and active=true;
  if owner_count>0 then raise exception 'An active Owner is already configured'; end if;
  if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'Signed-in account not found'; end if;
  select role into existing_role from public.members where id=target_user_id for update;
  insert into public.members(id,role,active) values(target_user_id,'owner',true)
    on conflict(id) do update set role='owner',active=true;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(target_user_id,'owner.initialized',target_user_id,jsonb_build_object('previous_role',existing_role));
end;
$$;

create or replace function public.assign_invited_member(target_user_id uuid, assigned_role text, owner_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.members where id=owner_user_id and role='owner' and active=true) then raise exception 'Owner access required'; end if;
  if assigned_role not in ('owner','manager','intern','quant') or assigned_role is null then raise exception 'Choose a supported club role'; end if;
  if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'Invited account not found'; end if;
  insert into public.members(id,role,active) values(target_user_id,assigned_role,true)
    on conflict(id) do update set role=excluded.role,active=true;
  insert into public.audit_log(actor_id,action,target_user_id,details)
    values(owner_user_id,'member.invited',target_user_id,jsonb_build_object('role',assigned_role));
end;
$$;

revoke all on function public.has_permission(text),public.is_manager(),public.my_permissions(),public.can_access_member_portfolio(uuid),public.can_read_proposal(uuid),
  public.review_proposal(uuid,text,text),public.override_proposal(uuid,text,text),public.execute_proposal(uuid,numeric),public.list_club_members(),
  public.list_proposal_authors(),public.list_visible_portfolios(),public.add_quant_analysis(uuid,text,text,jsonb),
  public.list_admin_members(),public.set_portfolio_coverage(uuid,text,uuid[]),public.set_member_role(uuid,text),public.set_user_permission(uuid,text,text),
  public.remove_member(uuid),public.bootstrap_initial_owner(uuid),public.assign_invited_member(uuid,text,uuid)
  from public;
revoke all on function public.is_owner() from public;
grant execute on function public.is_owner(),public.has_permission(text),public.is_manager(),public.my_permissions(),public.can_access_member_portfolio(uuid),public.can_read_proposal(uuid),
  public.review_proposal(uuid,text,text),public.override_proposal(uuid,text,text),public.execute_proposal(uuid,numeric),public.list_club_members(),
  public.list_proposal_authors(),public.list_visible_portfolios(),public.add_quant_analysis(uuid,text,text,jsonb),
  public.list_admin_members(),public.set_portfolio_coverage(uuid,text,uuid[]),public.set_member_role(uuid,text),public.set_user_permission(uuid,text,text),
  public.remove_member(uuid) to authenticated;
grant execute on function public.bootstrap_initial_owner(uuid),public.assign_invited_member(uuid,text,uuid)
  to service_role;

commit;
