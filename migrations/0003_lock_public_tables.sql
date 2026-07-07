-- 0003_lock_public_tables.sql
-- Defense-in-depth for the tenancy model (AGENTS.md §5). Isolation in this system
-- is enforced at the application layer by the NestJS guards — NOT by RLS. That
-- holds only if the guarded backend is the ONLY way to reach the data. But the
-- browser ships the Supabase publishable/anon key, and Supabase auto-exposes a
-- PostgREST API over the `public` schema, which that key can call DIRECTLY —
-- bypassing NestJS entirely. `public.branches` and `public.profiles` live in that
-- exposed schema, so without this they are readable cross-tenant via PostgREST.
--
-- Enabling RLS with NO policies makes PostgREST return nothing to the anon /
-- authenticated roles, closing that side door. The backend connects as the
-- `postgres` role (BYPASSRLS), so every existing guarded query is unaffected —
-- the app behaves identically; only the direct REST path is sealed.
--
-- Not covered here (by design): `srd.service_requests` and other domain tables
-- live in custom schemas that Supabase does NOT expose to PostgREST by default,
-- so the anon key cannot reach them. Keep those schemas OFF the API "Exposed
-- schemas" list and they stay sealed without needing RLS.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already enabled.
-- Apply via the Supabase SQL editor.

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
