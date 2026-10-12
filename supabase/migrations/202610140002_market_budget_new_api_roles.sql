begin;

-- New Supabase secret API keys authorize the trusted service role without a
-- legacy JWT claim. PostgREST still sets its active SQL role, so accept that
-- authenticated role signal while retaining the execute grant as the boundary.
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
  if coalesce(
    nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('role',true),'')
  ) is distinct from 'service_role' then
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
