-- 0012_retire_public_profiles.sql
-- Retires the public.profiles mirror. Identity now lives entirely in Supabase
-- Auth: CRM claims (role, branch scope, status, display fields) are stored in
-- each auth user's app_metadata (service-role-only, so they can't be self-edited)
-- and read straight from the verified JWT (AGENTS.md §5, §6). With this applied,
-- the `public` schema is empty — nothing is reachable via Supabase's anon
-- PostgREST path, so no per-table RLS lockdown is needed.
--
-- Apply via the Supabase SQL editor. Order matters: BACKFILL FIRST, then tear
-- down, then have every user sign out/in so their token carries the new claims.
-- This is destructive (drops a table) — take a snapshot first if unsure.

-- 1) Backfill: copy each profile row's claims into the auth user's app_metadata.
--    `||` shallow-merges, preserving any keys Supabase already set.
update auth.users u
set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
  'username',     p.username,
  'display_name', p.display_name,
  'role',         p.role,
  'branches',     to_jsonb(coalesce(p.branches, '{}'::text[])),
  'phone',        p.phone,
  'status',       p.status
)
from public.profiles p
where p.id = u.id;

-- 2) Stop the mirror. The trigger fired on new auth users to seed public.profiles;
--    provisioning now writes app_metadata directly, so it is obsolete. Confirm the
--    function name in your project (Supabase's default template is handle_new_user).
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- 3) Empty the public schema. profiles is fully superseded by auth app_metadata.
drop table if exists public.profiles;

-- If an early build ever created public.branches (superseded by core.branches in
-- 0001), drop it too so `public` is genuinely empty:
--   drop table if exists public.branches;

-- 4) OPERATIONAL: existing sessions keep their old token until refresh. Have all
--    users sign out and back in so the guard sees role/branches in app_metadata.
