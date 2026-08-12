-- Pocket Reader profile storage (replaces the Anvil user_profiles Data Table).
-- See MIGRATION_PLAN.md Phase 4.
--
-- Design notes:
--  * profile_data is jsonb, mirroring the schema-v3 object the client already
--    sends. The merge itself runs in the sync-profile Edge Function, which is a
--    direct port of Server_code.py's per-field-clock merge.
--  * revision is the concurrency token. Writes go through commit_user_profile(),
--    a compare-and-swap, so two devices syncing at once cannot silently clobber
--    one another -- the loser retries against fresh data. This replaces Anvil's
--    serializable in_transaction retry.
--  * The avatar lives in its own columns, never inside profile_data, so profile
--    syncs stay small. This matches the Anvil server-only avatar_media column.
--  * RLS restricts every row to its owner. The publishable/anon key is designed
--    to ship in frontend JS; these policies are what actually enforce access.

create table if not exists public.user_profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  profile_data jsonb       not null default '{}'::jsonb,
  revision     bigint      not null default 0,
  avatar_bytes bytea,
  avatar_mime  text,
  avatar_hash  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Mirrors MAX_PROFILE_BYTES (1 MiB) from the Anvil server. Enforced here too
  -- so a client that bypasses the Edge Function still cannot bloat the row.
  constraint profile_data_size check (pg_column_size(profile_data) <= 1048576),
  constraint avatar_size check (avatar_bytes is null or octet_length(avatar_bytes) <= 262144)
);

comment on table public.user_profiles is
  'One schema-v3 Pocket Reader profile per auth user. Merged by the sync-profile Edge Function.';

alter table public.user_profiles enable row level security;

-- Owner-only access. Separate policies per command so the intent is explicit
-- and a future permissive SELECT cannot accidentally widen writes.
drop policy if exists user_profiles_select_own on public.user_profiles;
create policy user_profiles_select_own on public.user_profiles
  for select using (auth.uid() = user_id);

drop policy if exists user_profiles_insert_own on public.user_profiles;
create policy user_profiles_insert_own on public.user_profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists user_profiles_update_own on public.user_profiles;
create policy user_profiles_update_own on public.user_profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists user_profiles_delete_own on public.user_profiles;
create policy user_profiles_delete_own on public.user_profiles
  for delete using (auth.uid() = user_id);

-- Keep updated_at honest regardless of who writes.
create or replace function public.touch_user_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_profiles_touch on public.user_profiles;
create trigger user_profiles_touch before update on public.user_profiles
  for each row execute function public.touch_user_profile();

/*
  Atomic compare-and-swap commit.

  The caller reads (profile_data, revision), merges, then calls this with the
  revision it read. The UPDATE only lands if revision is still that value, so a
  concurrent write from another device makes this return null and the caller
  retries against fresh data. That is the property Anvil got from a serializable
  transaction, expressed as an explicit token instead.

  security invoker (the default) on purpose: RLS still applies, so this cannot
  be used to write another user's row even though it is callable by anon.
*/
create or replace function public.commit_user_profile(
  p_expected_revision bigint,
  p_profile           jsonb
)
returns table (revision bigint, updated_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_expected_revision = 0 and not exists (
    select 1 from public.user_profiles up where up.user_id = v_uid
  ) then
    insert into public.user_profiles (user_id, profile_data, revision)
    values (v_uid, p_profile, 1)
    on conflict (user_id) do nothing;

    -- on conflict means a concurrent insert won; report no-commit so the caller
    -- re-reads and merges against it rather than discarding their work.
    if not found then
      return;
    end if;

    return query
      select up.revision, up.updated_at
      from public.user_profiles up
      where up.user_id = v_uid;
  end if;

  return query
    update public.user_profiles up
       set profile_data = p_profile,
           revision     = up.revision + 1
     where up.user_id = v_uid
       and up.revision = p_expected_revision
    returning up.revision, up.updated_at;
end;
$$;

revoke all on function public.commit_user_profile(bigint, jsonb) from public;
grant execute on function public.commit_user_profile(bigint, jsonb) to authenticated;
