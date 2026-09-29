-- deploy/db/auth-init.sql
-- Run by the one-shot `auth-init` service in docker-compose.yml (compose
-- profile `identity`), on EVERY `docker compose up` that enables identity —
-- not, like deploy/db/roles.sql, only on the first boot of a fresh volume.
--
-- WHY THIS FILE EXISTS SEPARATELY FROM roles.sql
--
-- GoTrue logs into Postgres as `supabase_auth_admin`, and that role has no
-- password until somebody sets one. roles.sql is mounted into
-- /docker-entrypoint-initdb.d/init-scripts/, which the supabase/postgres image
-- runs ONCE, when the data volume is empty. So on an install that already has
-- a volume — every install that is upgrading, which is the only kind that can
-- be switching identity on — roles.sql never runs again and the role keeps the
-- empty password it was created with. GoTrue then fails to connect and the
-- operator sees an auth container restart-looping with "password
-- authentication failed", against a database that looks perfectly healthy.
--
-- This script closes that gap, and it covers BOTH cases: the existing volume
-- that roles.sql will never see again, and the fresh one where the image and
-- roles.sql have already done the equivalent work — it is idempotent, so
-- running it a second time changes nothing. `auth` waits for it to exit 0
-- before starting.
--
-- WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT
--
--   1. Sets the supabase_auth_admin password from POSTGRES_PASSWORD, the same
--      value the rest of the stack uses. The role itself is NOT created here:
--      the supabase/postgres image creates it, in its own
--      init-scripts/00000000000001-auth-schema.sql
--      (`CREATE USER supabase_auth_admin NOINHERIT CREATEROLE LOGIN
--      NOREPLICATION`), so if this ALTER reports "role does not exist" the
--      volume was not initialised by that image and the right answer is a loud
--      failure, not a silently-created role with different attributes.
--   2. Makes sure the `auth` schema exists and is owned by supabase_auth_admin.
--      GoTrue runs its OWN migrations inside that schema at start-up (creating
--      auth.users, auth.sessions, auth.refresh_tokens, …), which needs
--      ownership, not merely a grant. The image creates the schema owned by
--      supabase_admin and re-owns only the tables in it, so the ownership is
--      moved here; on a volume where the schema is missing entirely it is
--      created with the right owner straight away.
--
-- It does NOT create or alter any table inside `auth`: those belong to GoTrue's
-- migration history, and a hand-written copy here would drift from the version
-- the pinned image ships.
--
-- Run as supabase_admin (a superuser in this image — its own
-- 00000000000000-initial-schema.sql grants it), because altering another
-- role's password and a schema's owner both require it. The `postgres` role is
-- deliberately NOT used: the image demotes it to NOSUPERUSER.
--
-- The password is read from the environment through a psql variable so it
-- never appears in this file, in the compose command line, or in a log. Same
-- pattern as deploy/db/roles.sql and deploy/db/jwt.sql.

\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
ALTER SCHEMA auth OWNER TO supabase_auth_admin;

-- Only needed on the CREATE path above (a schema this script created has no
-- grants at all), and harmless on the normal path where the image already
-- granted it. RLS policies that call auth.uid() run as the API roles, so
-- without USAGE on the schema they fail with "permission denied for schema
-- auth" rather than answering who the caller is.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
