-- deploy/db/roles.sql
-- Mounted as /docker-entrypoint-initdb.d/init-scripts/99-roles.sql; runs once,
-- on the first boot of a fresh supabase-db-data volume.
--
-- Adapted from Supabase's self-host docker/volumes/db/roles.sql. The image
-- creates the roles itself; this only gives the ones this stack logs in with
-- the generated password. supabase_admin (used by Realtime) already gets
-- POSTGRES_PASSWORD from the image's own init. The upstream file also sets
-- supabase_functions_admin, pgbouncer and supabase_storage_admin; this stack
-- runs none of those services, and supabase_functions_admin does not even
-- exist without the webhooks script, so setting it aborts the whole init.
--
-- supabase_auth_admin is the one role here that a DEFAULT install does not use:
-- GoTrue (the `auth` service, compose profile `identity`) logs in as it, and
-- docs/plan/13-identity.md makes identity a per-deployment choice. Setting its
-- password unconditionally is still correct, and it has to happen here as well
-- as in deploy/db/auth-init.sql: this file is the ONLY thing that runs on a
-- fresh volume, and auth-init.sql is the only thing that runs on an existing
-- one. An install that starts with identity off and switches it on later gets
-- the password from auth-init; one that starts with it on gets it from here on
-- the very first boot and again, harmlessly, from auth-init.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
