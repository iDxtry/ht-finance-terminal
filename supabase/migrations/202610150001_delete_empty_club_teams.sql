begin;

create or replace function public.delete_club_team(p_team_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  normalized_code text := upper(btrim(coalesce(p_team_code,'')));
  normalized_name text;
begin
  if not public.is_owner() then raise exception 'Owner access required'; end if;
  if normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then raise exception 'Choose a valid group'; end if;

  perform pg_catalog.pg_advisory_xact_lock(874312654,1);
  select t.team_name into normalized_name
    from public.club_teams t where t.team_code=normalized_code for update;
  if not found then raise exception 'Group not found'; end if;
  if exists(select 1 from public.club_team_members tm where tm.team_code=normalized_code)
    or exists(select 1 from public.club_team_managers tm where tm.team_code=normalized_code) then
    raise exception 'Remove all group members and Managers before deleting this group';
  end if;

  insert into public.audit_log(actor_id,action,details)
    values(auth.uid(),'team.deleted',jsonb_build_object('team_code',normalized_code,'team_name',normalized_name));
  delete from public.club_teams where team_code=normalized_code;
end;
$$;

revoke all on function public.delete_club_team(text) from public,anon,authenticated;
grant execute on function public.delete_club_team(text) to authenticated;

commit;
